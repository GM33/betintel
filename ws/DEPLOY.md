# BetIntel WebSocket Server — Deployment Guide

## Architecture

```
The Odds API
    │
    ▼
[ws/ingest.js]  ──── Redis SET ────▶  [betintel:odds:{sport}:h2h]
    │                                          │
    └──── Redis PUBLISH ──▶  [betintel:delta:{sport}]  ◀── [api/odds.js REST]
                                       │
                                  [ws/server.js]
                                       │
                              WebSocket broadcast
                                       │
                               Browser clients
```

## Quick Start (local)

```bash
cd ws
cp .env.example .env
# fill in REDIS_URL, ODDS_API_KEY, WS_AUTH_SECRET
npm install

# Terminal 1: WS server
npm start

# Terminal 2: Ingest worker
npm run ingest
```

## Production: Railway (recommended)

1. Create a new Railway project
2. Add two services from the `ws/` directory:
   - **ws-server**: `node server.js`
   - **ws-ingest**: `node ingest.js`
3. Add a Redis plugin to the project
4. Set env vars on both services (copy from `.env.example`)
5. Set `WS_ALLOWED_ORIGINS` to your Vercel URL
6. Copy the public URL of `ws-server` → use as `BETINTEL_WS_URL` in your frontend

## Production: Fly.io

```bash
# From repo root
cd ws
flyctl launch --config fly.toml --dockerfile Dockerfile
flyctl secrets set REDIS_URL=... ODDS_API_KEY=... WS_AUTH_SECRET=...
flyctl deploy
```

Run the ingest worker as a **separate Fly Machine**:
```bash
flyctl machine run . --dockerfile Dockerfile --command "node ingest.js" \
  --env REDIS_URL=... --env ODDS_API_KEY=...
```

## Generating WS_AUTH_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The frontend token is computed as:
```js
const crypto = require('crypto');
const token = crypto
  .createHmac('sha256', WS_AUTH_SECRET)
  .update('betintel-ws-auth')
  .digest('base64');
// Pass as: wss://host/ws?token=<token>
```

## Activate in frontend

In `index.html`, find the `initWebSocket()` function and:
1. Uncomment the block
2. Set `BETINTEL_WS_URL` to your deployed WS server URL
3. Set the token query param

## Health Check

```
GET https://your-ws-host/health
```
Returns: connected clients, rooms, messages sent, uptime.

## Scaling

- Single instance handles ~500 concurrent connections comfortably on 256MB RAM
- For >1k connections: add a second instance + use Redis to coordinate broadcasts
  (ws/server.js already uses Redis Pub/Sub, so multi-instance works out of the box)
