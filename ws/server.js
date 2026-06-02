/**
 * ws/server.js
 * BetIntel WebSocket Server
 *
 * Architecture:
 *  - Node HTTP server + ws library (no socket.io)
 *  - Redis Pub/Sub for receiving ingest deltas
 *  - Redis GET for snapshotting current state
 *  - One TCP port, deployable to Railway / Fly.io / Render
 *
 * Env vars required:
 *  REDIS_URL           — Redis connection string
 *  WS_PORT             — TCP port (default 8080)
 *  WS_AUTH_SECRET      — Shared secret for token validation
 *  WS_ALLOWED_ORIGINS  — Comma-separated allowed origins (default *)
 *  WS_MAX_CLIENTS      — Max simultaneous connections (default 500)
 */

'use strict';

const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const Redis     = require('ioredis');
const crypto    = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT            = Number(process.env.WS_PORT || 8080);
const AUTH_SECRET     = process.env.WS_AUTH_SECRET || '';
const MAX_CLIENTS     = Number(process.env.WS_MAX_CLIENTS || 500);
const ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const HEARTBEAT_INTERVAL_MS  = 30000;
const STALE_CLIENT_MS        = 90000;   // kick client if no pong in 90s
const SNAPSHOT_CACHE_KEY     = (sport, markets) => `betintel:odds:${sport}:${markets}`;
const PUBSUB_CHANNEL         = (sport) => `betintel:delta:${sport}`;
const ALLOWED_SPORTS         = new Set(
  (process.env.BETINTEL_ALLOWED_SPORTS ||
   'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// ── Redis ────────────────────────────────────────────────────────────────────
const redisSub = new Redis(process.env.REDIS_URL);
const redisGet = new Redis(process.env.REDIS_URL);

redisSub.on('error', err => console.error('[redis:sub]', err.message));
redisGet.on('error', err => console.error('[redis:get]', err.message));

// ── State ────────────────────────────────────────────────────────────────────
// sport -> Set<WebSocket>
const sportRooms   = new Map();
// ws -> ClientContext
const clients      = new WeakMap();
let   clientCount  = 0;
let   totalMsgSent = 0;
let   startedAt    = Date.now();

// ── Auth ─────────────────────────────────────────────────────────────────────
function validateToken(token) {
  if (!AUTH_SECRET) return true;   // auth disabled if no secret set
  if (!token) return false;
  // HMAC-SHA256: token = base64(hmac(secret, 'betintel-ws-auth'))
  const expected = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update('betintel-ws-auth')
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expected)
  );
}

// ── Origin check ─────────────────────────────────────────────────────────────
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
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
  const key = SNAPSHOT_CACHE_KEY(sport, 'h2h');
  try {
    const raw = await redisGet.get(key);
    if (!raw) {
      ws.send(JSON.stringify({
        type: 'status',
        mode: 'simulated',
        sport,
        message: 'No snapshot available yet — ingest may still be loading',
      }));
      return;
    }
    const snapshot = JSON.parse(raw);
    ws.send(JSON.stringify({
      type:      'snapshot',
      sport,
      events:    snapshot.events || [],
      dataSource: snapshot.dataSource || 'cache',
      stale:     snapshot.stale || false,
      cachedAt:  snapshot.cachedAt,
    }));
    totalMsgSent++;
  } catch (err) {
    console.error('[ws] snapshot error', err.message);
  }
}

// ── Redis Pub/Sub ─────────────────────────────────────────────────────────────
// Subscribe to all allowed sport channels at startup
async function subscribeAll() {
  for (const sport of ALLOWED_SPORTS) {
    await redisSub.subscribe(PUBSUB_CHANNEL(sport));
    console.log(`[pubsub] subscribed to ${PUBSUB_CHANNEL(sport)}`);
  }
}

redisSub.on('message', (channel, message) => {
  // channel format: betintel:delta:<sport>
  const sport = channel.replace('betintel:delta:', '');
  let delta;
  try { delta = JSON.parse(message); } catch { return; }

  // Forward to all subscribers of this sport
  broadcast(sport, {
    type:   'delta',
    sport,
    ...delta,
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat(wss) {
  setInterval(() => {
    const now = Date.now();
    wss.clients.forEach(ws => {
      const ctx = clients.get(ws);
      if (!ctx) { ws.terminate(); return; }
      // Kill stale clients
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

// ── HTTP server (health + upgrade) ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const payload = JSON.stringify({
      ok:          true,
      clients:     clientCount,
      rooms:       Object.fromEntries([...sportRooms.entries()].map(([k,v]) => [k, v.size])),
      msgSent:     totalMsgSent,
      uptimeMs:    Date.now() - startedAt,
      ts:          new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Origin check
  const origin = req.headers['origin'] || '';
  if (!isAllowedOrigin(origin)) {
    console.warn(`[ws] rejected origin: ${origin}`);
    ws.close(4003, 'Origin not allowed');
    return;
  }

  // Capacity check
  if (clientCount >= MAX_CLIENTS) {
    ws.close(4029, 'Server at capacity');
    return;
  }

  // Token auth via query string: /ws?token=xxx
  const url    = new URL(req.url, 'http://localhost');
  const token  = url.searchParams.get('token') || '';
  if (!validateToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  clientCount++;
  const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  clients.set(ws, { id: clientId, sports: new Set(), lastPong: Date.now() });

  console.log(`[ws] connected ${clientId} (total: ${clientCount})`);

  // Send welcome status
  ws.send(JSON.stringify({
    type:    'status',
    mode:    'live',
    message: 'Connected to BetIntel live feed',
  }));
  totalMsgSent++;

  // ── Message handler ──
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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
      const sport = String(msg.sport || '').trim();
      leaveRoom(ws, sport);

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

  ws.on('close', (code, reason) => {
    clientCount = Math.max(0, clientCount - 1);
    leaveAllRooms(ws);
    console.log(`[ws] disconnected ${clientId} code=${code} (total: ${clientCount})`);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error ${clientId}:`, err.message);
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await subscribeAll();
  startHeartbeat(wss);
  server.listen(PORT, () => {
    console.log(`[betintel-ws] listening on port ${PORT}`);
    console.log(`[betintel-ws] auth: ${AUTH_SECRET ? 'enabled' : 'DISABLED — set WS_AUTH_SECRET'}`);
    console.log(`[betintel-ws] origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
})()
.catch(err => {
  console.error('[betintel-ws] fatal startup error:', err);
  process.exit(1);
});
