// api/railway-events.js
// Receives outbound Railway deployment/service webhooks.
// Validates shared secret, stores last event in Redis (24h TTL).
// Register this URL in Railway → Project Settings → Webhooks:
//   URL:    https://betintel.bet/api/railway-events
//   Secret: value of RAILWAY_WEBHOOK_SECRET env var

const REDIS_KEY  = 'betintel:railway:lastEvent';
const REDIS_TTL  = 60 * 60 * 24; // 24 hours

let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', (err) => {
      console.error('[railway-events:redis]', err.message);
      _redis = null;
    });
    await client.connect();
    _redis = client;
    return _redis;
  } catch (err) {
    console.error('[railway-events:redis] connect failed:', err.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Secret validation ---
  const secret   = process.env.RAILWAY_WEBHOOK_SECRET;
  const incoming = req.headers['x-railway-signature'] ||
                   req.headers['x-webhook-secret']    ||
                   req.headers['authorization']?.replace('Bearer ', '');

  if (secret) {
    if (!incoming || incoming !== secret) {
      console.warn('[railway-events] rejected: invalid secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // --- Parse body ---
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  // Railway event envelope: { type, timestamp, project, environment, service, deployment, ... }
  const event = {
    type:        body.type        || body.event        || 'unknown',
    serviceId:   body.service?.id || body.serviceId    || null,
    serviceName: body.service?.name                    || null,
    deploymentId:body.deployment?.id                   || null,
    status:      body.deployment?.status || body.status || null,
    environment: body.environment?.name                || null,
    ts:          body.timestamp || new Date().toISOString(),
    receivedAt:  new Date().toISOString(),
  };

  console.log('[railway-events]', JSON.stringify(event));

  // --- Persist to Redis ---
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.setEx(REDIS_KEY, REDIS_TTL, JSON.stringify(event));
    }
  } catch (err) {
    // non-fatal — still return 200 so Railway doesn't retry forever
    console.error('[railway-events:redis] write failed:', err.message);
  }

  return res.status(200).json({ ok: true, event });
};
