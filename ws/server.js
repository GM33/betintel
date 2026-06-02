'use strict';

const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const Redis     = require('ioredis');
const crypto    = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT            = Number(process.env.WS_PORT || process.env.PORT || 8080);
const AUTH_SECRET     = process.env.WS_AUTH_SECRET || '';
const MAX_CLIENTS     = Number(process.env.WS_MAX_CLIENTS || 500);
const IS_PROD         = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const HEARTBEAT_INTERVAL_MS = 30000;
const STALE_CLIENT_MS       = 90000;
const MAX_MSG_BYTES         = 512;

const ALLOWED_SPORTS = new Set(
  (process.env.BETINTEL_ALLOWED_SPORTS ||
   'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// ── Redis ────────────────────────────────────────────────────────────────────
const redisSub = new Redis(process.env.REDIS_URL);
const redisGet = new Redis(process.env.REDIS_URL);

let redisReady = false;
redisSub.on('error', err => console.error('[redis:sub]', err.message));
redisGet.on('error', err => { console.error('[redis:get]', err.message); redisReady = false; });
redisGet.on('ready', () => { redisReady = true; });
redisSub.on('ready', () => {
  redisReady = true;
  subscribeAll().catch(err => console.error('[pubsub] resubscribe error:', err.message));
});

// ── State ────────────────────────────────────────────────────────────────────
const sportRooms   = new Map();
const clients      = new WeakMap();
let   clientCount  = 0;
let   totalMsgSent = 0;
const startedAt    = Date.now();

// ── Auth ─────────────────────────────────────────────────────────────────────
function makeExpectedToken(secret, hourOffset = 0) {
  const bucket = Math.floor(Date.now() / 3_600_000) + hourOffset;
  return crypto
    .createHmac('sha256', secret)
    .update(`betintel-ws-auth:${bucket}`)
    .digest('base64');
}

function validateToken(token) {
  if (!AUTH_SECRET) return true;
  if (!token || typeof token !== 'string') return false;
  const MAX_LEN = 128;
  function padBuf(str) {
    const b = Buffer.alloc(MAX_LEN, 0);
    Buffer.from(str).copy(b, 0, 0, Math.min(str.length, MAX_LEN));
    return b;
  }
  const incoming = padBuf(token);
  for (const offset of [0, -1]) {
    const expected = makeExpectedToken(AUTH_SECRET, offset);
    if (token.length === expected.length && crypto.timingSafeEqual(incoming, padBuf(expected))) return true;
  }
  return false;
}

// ── Origin check ─────────────────────────────────────────────────────────────
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (!IS_PROD && (!origin || origin.includes('localhost') || origin.includes('127.0.0.1'))) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o));
}

// ── CORS helper for HTTP endpoints ───────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Room helpers ─────────────────────────────────────────────────────────────
function joinRoom(ws, sport) {
  if (!sportRooms.has(sport)) sportRooms.set(sport, new Set());
  sportRooms.get(sport).add(ws);
  const ctx = clients.get(ws);
  if (ctx) ctx.sports.add(sport);
}

function leaveRoom(ws, sport) {
  const room = sportRooms.get(sport);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) sportRooms.delete(sport);
  const ctx = clients.get(ws);
  if (ctx) ctx.sports.delete(sport);
}

function leaveAllRooms(ws) {
  const ctx = clients.get(ws);
  if (!ctx) return;
  for (const sport of [...ctx.sports]) leaveRoom(ws, sport);
}

function broadcast(sport, msg) {
  const room = sportRooms.get(sport);
  if (!room || room.size === 0) return;
  const raw = JSON.stringify(msg);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(raw); totalMsgSent++; }
  }
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────
async function getSnapshot(sport) {
  const key = `betintel:odds:${sport}:h2h`;
  try {
    const raw = await redisGet.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

async function sendSnapshot(ws, sport) {
  const snapshot = await getSnapshot(sport);
  if (!snapshot) {
    ws.send(JSON.stringify({
      type: 'status', mode: 'simulated', sport,
      message: 'No snapshot available yet — ingest may still be loading',
    }));
    return;
  }
  ws.send(JSON.stringify({
    type:       'snapshot',
    sport,
    events:     snapshot.events || [],
    dataSource: snapshot.dataSource || 'cache',
    stale:      snapshot.stale || false,
    cachedAt:   snapshot.cachedAt,
  }));
  totalMsgSent++;
}

// ── Health helpers ────────────────────────────────────────────────────────────
async function getHealthPayload() {
  // Probe provider reachability via a lightweight Redis key written by ingest
  // Falls back to checking if ANY odds snapshot exists in Redis
  let providerOk   = false;
  let cacheAgeSec  = null;
  let quotaRemaining = null;
  let mode         = 'simulated';

  try {
    // Check any snapshot for freshness
    const sports = [...ALLOWED_SPORTS];
    for (const sport of sports) {
      const snap = await getSnapshot(sport);
      if (snap) {
        const age = snap.cachedAt ? Math.round((Date.now() - new Date(snap.cachedAt).getTime()) / 1000) : null;
        cacheAgeSec   = age;
        quotaRemaining = snap.quota?.remaining ?? null;
        providerOk    = snap.dataSource === 'live';
        mode          = snap.stale ? 'cached' : (snap.dataSource === 'live' ? 'live' : 'cached');
        break; // first found is enough
      }
    }
  } catch (err) {
    console.error('[health] snapshot probe error:', err.message);
  }

  return {
    ok:              true,
    mode,                          // 'live' | 'cached' | 'simulated'
    provider_ok:     providerOk,   // true when last ingest hit the live API
    redis_ok:        redisReady,
    quota_remaining: quotaRemaining,
    cache_age_s:     cacheAgeSec,
    clients:         clientCount,
    rooms:           Object.fromEntries([...sportRooms.entries()].map(([k, v]) => [k, v.size])),
    msgSent:         totalMsgSent,
    uptimeMs:        Date.now() - startedAt,
    ts:              new Date().toISOString(),
  };
}

// ── Redis Pub/Sub ─────────────────────────────────────────────────────────────
async function subscribeAll() {
  for (const sport of ALLOWED_SPORTS) {
    await redisSub.subscribe(`betintel:delta:${sport}`);
    console.log(`[pubsub] subscribed to betintel:delta:${sport}`);
  }
}

redisSub.on('message', (channel, message) => {
  const sport = channel.replace('betintel:delta:', '');
  let delta;
  try { delta = JSON.parse(message); } catch { return; }
  broadcast(sport, { type: 'delta', sport, ...delta });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat(wss) {
  setInterval(() => {
    const now = Date.now();
    wss.clients.forEach(ws => {
      const ctx = clients.get(ws);
      if (!ctx) { ws.terminate(); return; }
      if (now - ctx.lastPong > STALE_CLIENT_MS) {
        console.log(`[ws] terminating stale client ${ctx.id}`);
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'ping', ts: now })); totalMsgSent++; }
    });
  }, HEARTBEAT_INTERVAL_MS);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = new URL(req.url, 'http://localhost');

  // ── GET /health or GET / ───────────────────────────────────────────────────
  if (url.pathname === '/health' || url.pathname === '/') {
    try {
      const payload = await getHealthPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── GET /api/odds?sport=xxx ────────────────────────────────────────────────
  if (url.pathname === '/api/odds') {
    const sportParam = url.searchParams.get('sport');
    try {
      const allSports = sportParam && ALLOWED_SPORTS.has(sportParam)
        ? [sportParam]
        : [...ALLOWED_SPORTS];

      const allEvents = [];
      for (const sport of allSports) {
        const snap = await getSnapshot(sport);
        if (snap && snap.events) {
          // Re-shape back to the-odds-api format the frontend expects
          for (const ev of snap.events) {
            allEvents.push({
              id:            ev.id,
              sport_key:     ev.sportKey,
              sport_title:   ev.sportTitle,
              commence_time: ev.commenceTime,
              home_team:     ev.homeTeam,
              away_team:     ev.awayTeam,
              bookmakers:    (ev.bookmakers || []).map(bm => ({
                key:         bm.bookmakerKey,
                title:       bm.title,
                last_update: bm.lastUpdate,
                markets:     (bm.markets || []).map(m => ({
                  key:      m.marketKey,
                  outcomes: (m.outcomes || []).map(o => ({
                    name:  o.name,
                    price: o.price,
                    point: o.point,
                  }))
                }))
              }))
            });
          }
        }
      }

      // Determine mode from first available snapshot
      let mode = 'simulated';
      for (const sport of allSports) {
        const snap = await getSnapshot(sport);
        if (snap) { mode = snap.stale ? 'cached' : (snap.dataSource === 'live' ? 'live' : 'cached'); break; }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mode,
        count:     allEvents.length,
        games:     allEvents,
        updatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const origin = req.headers['origin'] || '';
  if (!isAllowedOrigin(origin)) {
    console.warn(`[ws] rejected origin: ${origin}`);
    ws.close(4003, 'Origin not allowed');
    return;
  }

  if (clientCount >= MAX_CLIENTS) {
    ws.close(4029, 'Server at capacity'); return;
  }

  const wsUrl  = new URL(req.url, 'http://localhost');
  const token  = wsUrl.searchParams.get('token') || '';
  if (!validateToken(token)) {
    ws.close(4001, 'Unauthorized'); return;
  }

  clientCount++;
  const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  clients.set(ws, { id: clientId, sports: new Set(), lastPong: Date.now() });
  console.log(`[ws] connected ${clientId} (total: ${clientCount})`);

  ws.send(JSON.stringify({ type: 'status', mode: 'live', message: 'Connected to BetIntel live feed' }));
  totalMsgSent++;

  ws.on('message', async (rawBuf) => {
    if (rawBuf.length > MAX_MSG_BYTES) return;
    let msg;
    try { msg = JSON.parse(rawBuf); } catch { return; }
    const ctx = clients.get(ws);
    if (!ctx) return;

    if (msg.type === 'subscribe') {
      const sport = String(msg.sport || '').trim();
      if (!ALLOWED_SPORTS.has(sport)) {
        ws.send(JSON.stringify({ type: 'error', code: 'UNSUPPORTED_SPORT', sport }));
        return;
      }
      joinRoom(ws, sport);
      await sendSnapshot(ws, sport);
    } else if (msg.type === 'unsubscribe') {
      leaveRoom(ws, String(msg.sport || '').trim());
    } else if (msg.type === 'ping') {
      ctx.lastPong = Date.now();
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      totalMsgSent++;
    }
  });

  ws.on('pong', () => { const ctx = clients.get(ws); if (ctx) ctx.lastPong = Date.now(); });

  ws.on('close', (code) => {
    clientCount = Math.max(0, clientCount - 1);
    leaveAllRooms(ws);
    console.log(`[ws] disconnected ${clientId} code=${code} (total: ${clientCount})`);
  });

  ws.on('error', err => console.error(`[ws] error ${clientId}:`, err.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[betintel-ws] ${signal} — shutting down`);
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => { redisSub.quit(); redisGet.quit(); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await subscribeAll();
  startHeartbeat(wss);
  server.listen(PORT, () => {
    console.log(`[betintel-ws] listening on port ${PORT}`);
    console.log(`[betintel-ws] auth: ${AUTH_SECRET ? 'enabled (hourly rotation)' : 'DISABLED'}`);
    console.log(`[betintel-ws] origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`[betintel-ws] endpoints: GET /health, GET /api/odds, WS /ws`);
  });
})().catch(err => { console.error('[betintel-ws] fatal:', err); process.exit(1); });
