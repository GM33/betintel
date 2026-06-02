# BetIntel WS — Railway Deployment Guide

## Architecture

```
The-Odds-API
    │
    ▼
[ws-ingest] ──PUBLISH──► Redis ──SUBSCRIBE──► [ws-server] ──push──► Browser
```

## Step 1 — Create Railway Project

1. Go to https://railway.app → New Project → Deploy from GitHub
2. Select `GM33/betintel`
3. DO NOT auto-deploy yet

## Step 2 — Add Redis Plugin

1. Inside project → + New → Database → Add Redis
2. Note the `REDIS_URL` from Variables tab (format: `redis://default:pw@redis.railway.internal:6379`)

## Step 3 — Deploy WS Server (Service 1: ws-server)

1. + New → GitHub Repo → GM33/betintel
2. Root Directory: `ws`
3. Start Command: `node server.js` (auto-detected from railway.toml)
4. Set environment variables:

```
REDIS_URL       = <from Step 2>
WS_AUTH_SECRET  = <run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
PORT            = 8080
NODE_ENV        = production
```

5. Deploy → wait for green health check at /health
6. Settings → Networking → Generate Domain
7. Copy domain → your WS URL is: `wss://<domain>/ws`

## Step 4 — Deploy Ingest Worker (Service 2: ws-ingest)

1. + New → GitHub Repo → GM33/betintel (same repo, second service)
2. Root Directory: `ws`
3. **Override** Start Command: `node ingest.js`
4. Set environment variables:

```
REDIS_URL       = <same as Step 2>
ODDS_API_KEY    = <your The-Odds-API key from https://the-odds-api.com>
WS_AUTH_SECRET  = <same secret as Step 3>
NODE_ENV        = production
```

5. Deploy → check logs for "Ingest cycle complete"

## Step 5 — Wire Vercel Frontend

In Vercel dashboard → Settings → Environment Variables:

```
BETINTEL_WS_URL   = wss://<railway-domain>/ws
WS_AUTH_SECRET    = <same secret from Step 3>
```

Vercel auto-generates the HMAC token at request time in api/index.js.
No token is stored — it's derived fresh every request.

## Step 6 — Verify

```bash
# 1. Health check
curl https://<railway-domain>/health

# 2. WebSocket test (install wscat: npm i -g wscat)
# Get token first:
node -e "
  const c=require('crypto');
  console.log(c.createHmac('sha256','YOUR_SECRET').update('betintel-ws-auth').digest('base64'));
"
wscat -c "wss://<railway-domain>/ws?token=<token>"
# Expect: {\"type\":\"snapshot\",\"events\":[...]}

# 3. Trigger ingest manually
railway run --service ws-ingest node ingest.js
```

## Environment Variable Reference

| Variable | Service | Required | Description |
|---|---|---|---|
| REDIS_URL | ws-server, ws-ingest | ✅ | Railway Redis private URL |
| WS_AUTH_SECRET | ws-server, ws-ingest, Vercel | ✅ | 32-byte hex secret for HMAC auth |
| ODDS_API_KEY | ws-ingest | ✅ | The-Odds-API key |
| PORT | ws-server | optional | Default 8080 |
| BETINTEL_WS_URL | Vercel | ✅ | Full wss:// URL to ws-server |
| NODE_ENV | both | optional | Set to production |

## Upgrade Note

Railway free tier sleeps services after inactivity.
Upgrade to **Hobby plan ($5/mo)** to keep ws-server always-on.
A sleeping WS server is useless — always-on is non-negotiable for real-time odds.
