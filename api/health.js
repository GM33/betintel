// api/health.js
// BetIntel health check — provider reachability, Redis status, cache age, quota, mode
//
// Fixes applied (audit):
//  #3  — No new Redis connection per request: reuse module-level persistent client
//  #15 — Quota read from Redis (shared across serverless instances) not in-process state

const { fetchOdds } = require('./_lib/odds');

const STALE_WINDOW_MS = Number(process.env.ODDS_STALE_WINDOW_SECONDS || 120) * 1000;
const PROBE_SPORT     = process.env.ODDS_HEALTH_PROBE_SPORT || 'baseball_mlb';

// FIX #3: module-level persistent Redis client — created once, reused across invocations
let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', (err) => {
      console.error('[health:redis]', err.message);
      _redis = null; // allow reconnect on next call
    });
    await client.connect();
    _redis = client;
    return _redis;
  } catch (err) {
    console.error('[health:redis] connect failed:', err.message);
    return null;
  }
}

// ---- Redis ping ----
async function pingRedis() {
  try {
    const redis = await getRedis();
    if (!redis) return { status: 'unconfigured', latencyMs: null };
    const t0 = Date.now();
    await redis.ping();
    return { status: 'ok', latencyMs: Date.now() - t0 };
  } catch (err) {
    _redis = null;
    return { status: 'error', latencyMs: null, message: err.message };
  }
}

// ---- Cache age + quota probe (FIX #3 + #15) ----
// Reads quota from the ingest snapshot in Redis (shared source of truth)
async function getCacheInfo(sport) {
  try {
    const redis = await getRedis();
    if (!redis) return { ageMs: null, quota: null };
    const raw = await redis.get(`betintel:odds:${sport}:h2h`);
    if (!raw) return { ageMs: null, quota: null };
    const parsed  = JSON.parse(raw);
    const ageMs   = parsed.cachedAt ? Date.now() - new Date(parsed.cachedAt).getTime() : null;
    // FIX #15: quota comes from the ingest snapshot — valid across all serverless instances
    const quota   = parsed.quota || null;
    return { ageMs, quota };
  } catch {
    return { ageMs: null, quota: null };
  }
}

// ---- Provider probe (quota-free /sports endpoint) ----
async function probeProvider() {
  const t0 = Date.now();
  const result = await fetchOdds('/sports', {}, { retries: 0, timeoutMs: 2000 });
  return {
    reachable:  result.ok,
    latencyMs:  Date.now() - t0,
    status:     result.status,
    errorCode:  result.errorCode ?? null,
  };
}

// ---- Mode resolution ----
function resolveMode({ providerReachable, cacheAgeMs }) {
  if (providerReachable) return 'live';
  if (cacheAgeMs !== null && cacheAgeMs < STALE_WINDOW_MS) return 'cached';
  return 'simulated';
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [redisResult, providerResult, cacheInfo] = await Promise.all([
    pingRedis(),
    probeProvider(),
    getCacheInfo(PROBE_SPORT),
  ]);

  const { ageMs: cacheAgeMs, quota } = cacheInfo;
  const mode    = resolveMode({ providerReachable: providerResult.reachable, cacheAgeMs });
  const healthy = providerResult.reachable && redisResult.status === 'ok';

  res.setHeader('Cache-Control', 'no-store');
  return res.status(healthy ? 200 : 207).json({
    healthy,
    mode,
    checkedAt: new Date().toISOString(),
    provider: {
      reachable:  providerResult.reachable,
      latencyMs:  providerResult.latencyMs,
      httpStatus: providerResult.status,
      errorCode:  providerResult.errorCode,
    },
    redis: {
      status:    redisResult.status,
      latencyMs: redisResult.latencyMs,
    },
    cache: {
      ageMs:   cacheAgeMs,
      ageSecs: cacheAgeMs !== null ? Math.round(cacheAgeMs / 1000) : null,
      stale:   cacheAgeMs !== null ? cacheAgeMs > STALE_WINDOW_MS : null,
    },
    // FIX #15: real quota from Redis ingest snapshot
    quota: quota ? {
      remaining:  quota.remaining,
      updatedAt:  quota.updatedAt,
    } : null,
  });
};
