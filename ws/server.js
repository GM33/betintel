/**
 * ws/server.js
 * BetIntel WebSocket Server
 *
 * Fixes applied (audit):
 *  #1  — timingSafeEqual crash: pad buffers to equal length before compare
 *  #4  — Token expiry: validate hourly HMAC rotation window
 *  #9  — Dev CORS: localhost always allowed in non-production
 */

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

redisSub.on('error', err => console.error('[redis:sub]', err.message));
redisGet.on('error', err => console.error('[redis:get]', err.message));

// Re-subscribe on reconnect so Redis drops don't permanently break pub/sub
redisSub.on('ready', () => {
  subscribeAll().catch(err => console.error('[pubsub] resubscribe error:', err.message));
});

// ── State ────────────────────────────────────────────────────────────────────
const sportRooms   = new Map();
const clients      = new WeakMap();
let   clientCount  = 0;
let   totalMsgSent = 0;
const startedAt    = Date.now();

// ── Auth — FIX #1 + #4 ───────────────────────────────────────────────────────
// Token = base64(HMAC-SHA256(secret, 'betintel-ws-auth:<hourBucket>'))
// Accepts current hour and previous hour to avoid clock-edge rejections.
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

  // FIX #1: pad both buffers to MAX_TOKEN_LEN before timingSafeEqual
  // so mismatched lengths never throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
  const MAX_LEN = 128;
  function padBuf(str) {
    const b = Buffer.alloc(MAX_LEN, 0);
    Buffer.from(str).copy(b, 0, 0, Math.min(str.length, MAX_LEN));
    return b;
  }

  const incoming = padBuf(token);

  // FIX #4: accept current hour and previous hour window
  for (const offset of [0, -1]) {
    const expected = makeExpectedToken(AUTH_SECRET, offset);
    if (
      token.length === expected.length &&
      crypto.timingSafeEqual(incoming, padBuf(expected))
    ) return true;
  }
  return false;
}

// ── Origin check — FIX #9 ─────────────────────────────────────────────────────
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  // Always allow localhost in non-prod for developer experience
  if (!IS_PROD && (!origin || origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    return true;
  }
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o));
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
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
      totalMsgSent++;
    }
  }
}

// ── Snapshot sender ───────────────────────────────────────────────────────────
async function sendSnapshot(ws, sport) {
  const key = `betintel:odds:${sport}:h2h`;
  try {
    const raw = await redisGet.get(key);
    if (!raw) {
      ws.send(JSON.stringify({
        type: 'status', mode: 'simulated', sport,
        message: 'No snapshot available yet — ingest may still be loading',
      }));
      return;
    }
    const snapshot = JSON.parse(raw);
    ws.send(JSON.stringify({
      type:       'snapshot',
      sport,
      events:     snapshot.events || [],
      dataSource: snapshot.dataSource || 'cache',
      stale:      snapshot.stale || false,
      cachedAt:   snapshot.cachedAt,
    }));
    totalMsgSent++;
  } catch (err) {
    console.error('[ws] snapshot error', err.message);
  }
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', ts: now }));
        totalMsgSent++;
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const payload = JSON.stringify({
      ok:       true,
      clients:  clientCount,
      rooms:    Object.fromEntries([...sportRooms.entries()].map(([k,v]) => [k, v.size])),
      msgSent:  totalMsgSent,
      uptimeMs: Date.now() - startedAt,
      ts:       new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
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
    ws.close(4029, 'Server at capacity');
    return;
  }

  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || '';
  if (!validateToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  clientCount++;
  const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  clients.set(ws, { id: clientId, sports: new Set(), lastPong: Date.now() });
  console.log(`[ws] connected ${clientId} (total: ${clientCount})`);

  ws.send(JSON.stringify({ type: 'status', mode: 'live', message: 'Connected to BetIntel live feed' }));
  totalMsgSent++;

  ws.on('message', async (rawBuf) => {
    // FIX: guard message size — never parse oversized payloads
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

  ws.on('pong', () => {
    const ctx = clients.get(ws);
    if (ctx) ctx.lastPong = Date.now();
  });

  ws.on('close', (code) => {
    clientCount = Math.max(0, clientCount - 1);
    leaveAllRooms(ws);
    console.log(`[ws] disconnected ${clientId} code=${code} (total: ${clientCount})`);
  });

  ws.on('error', err => console.error(`[ws] error ${clientId}:`, err.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[betintel-ws] ${signal} received — shutting down gracefully`);
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    redisSub.quit();
    redisGet.quit();
    process.exit(0);
  });
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
    console.log(`[betintel-ws] auth: ${AUTH_SECRET ? 'enabled (hourly rotation)' : 'DISABLED — set WS_AUTH_SECRET'}`);
    console.log(`[betintel-ws] origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
})().catch(err => {
  console.error('[betintel-ws] fatal startup error:', err);
  process.exit(1);
});
