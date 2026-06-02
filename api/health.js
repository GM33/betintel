// api/health.js
// BetIntel health check — provider reachability, Redis status, cache age, quota, mode

const { fetchOdds, getRateLimitState } = require('./_lib/odds');

const STALE_WINDOW_MS = Number(process.env.ODDS_STALE_WINDOW_SECONDS || 120) * 1000;
const PROBE_SPORT     = process.env.ODDS_HEALTH_PROBE_SPORT || 'baseball_mlb';

// ---- Redis ping ----
async function pingRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return { status: 'unconfigured', latencyMs: null };
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', () => {});
    const t0 = Date.now();
    await client.connect();
    await client.ping();
    const latencyMs = Date.now() - t0;
    await client.quit();
    return { status: 'ok', latencyMs };
  } catch (err) {
    return { status: 'error', latencyMs: null, message: err.message };
  }
}

// ---- Cache age probe ----
async function getCacheAge(sport) {
  try {
    const url = process.env.REDIS_URL;
    if (!url) return null;
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', () => {});
    await client.connect();
    const raw = await client.get(`betintel:odds:${sport}:h2h`);
    await client.quit();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.cachedAt ? Date.now() - new Date(parsed.cachedAt).getTime() : null;
  } catch {
    return null;
  }
}

// ---- Provider probe (lightweight — uses /sports which is quota-free) ----
async function probeProvider() {
  const t0 = Date.now();
  const result = await fetchOdds('/sports', {}, { retries: 0, timeoutMs: 2000 });
  const latencyMs = Date.now() - t0;
  return {
    reachable: result.ok,
    latencyMs,
    status: result.status,
    errorCode: result.errorCode ?? null,
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

  const [redisResult, providerResult, cacheAgeMs] = await Promise.all([
    pingRedis(),
    probeProvider(),
    getCacheAge(PROBE_SPORT),
  ]);

  const quota = getRateLimitState();
  const mode  = resolveMode({ providerReachable: providerResult.reachable, cacheAgeMs });

  const healthy = providerResult.reachable && redisResult.status === 'ok';

  const payload = {
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
    quota: {
      remaining:  quota.remaining,
      used:       quota.used,
      updatedAt:  quota.updatedAt,
    },
  };

  res.setHeader('Cache-Control', 'no-store');
  return res.status(healthy ? 200 : 207).json(payload);
};
