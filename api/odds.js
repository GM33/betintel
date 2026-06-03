// api/odds.js
// BetIntel live odds endpoint — Redis-backed cache, stale fallback, dataSource flag

const { fetchOdds, isAllowedSport, sanitizeMarkets, normalizeEvents, getRateLimitState, ERROR_CODES } = require('./_lib/odds');
const { maybeLogNbaSnapshot } = require('./_lib/nba-snapshot-hook');

// ---- Lightweight in-process cache (fallback when Redis is unavailable) ----
const inMemCache = new Map();
const IN_MEM_TTL_MS = 20000;

function inMemGet(key) {
  const entry = inMemCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IN_MEM_TTL_MS * 3) {
    inMemCache.delete(key);
    return null;
  }
  return entry;
}

function inMemSet(key, data) {
  inMemCache.set(key, { data, ts: Date.now() });
}

// ---- Redis helper (optional — gracefully absent) ----
let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', () => { redisClient = null; });
    await client.connect();
    redisClient = client;
    return redisClient;
  } catch {
    return null;
  }
}

const CACHE_TTL_SECONDS = Number(process.env.ODDS_CACHE_TTL_SECONDS || 20);
const STALE_WINDOW_SECONDS = Number(process.env.ODDS_STALE_WINDOW_SECONDS || 120);

async function cacheGet(key) {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    }
  } catch { /* fall through */ }
  const mem = inMemGet(key);
  return mem ? mem.data : null;
}

async function cacheSet(key, value) {
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.set(key, JSON.stringify(value), { EX: STALE_WINDOW_SECONDS });
      return;
    }
  } catch { /* fall through */ }
  inMemSet(key, value);
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sport   = String(req.query.sport || 'baseball_mlb');
  const markets = sanitizeMarkets(req.query.markets);
  const cacheKey = `betintel:odds:${sport}:${markets}`;

  if (!isAllowedSport(sport)) {
    return res.status(400).json({
      error: 'Unsupported sport',
      allowed: (process.env.BETINTEL_ALLOWED_SPORTS || 'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl').split(','),
    });
  }

  // 1. Try to serve from cache first for fast initial response
  const cached = await cacheGet(cacheKey);
  const cacheAgeMs = cached ? Date.now() - new Date(cached.cachedAt).getTime() : null;
  const cacheIsHot  = cacheAgeMs !== null && cacheAgeMs < CACHE_TTL_SECONDS * 1000;
  const cacheIsWarm = cacheAgeMs !== null && cacheAgeMs < STALE_WINDOW_SECONDS * 1000;

  if (cacheIsHot) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-BetIntel-Source', 'cache-hot');
    return res.status(200).json({ ...cached, dataSource: 'cache', stale: false });
  }

  // 2. Fetch live from The Odds API
  try {
    const result = await fetchOdds(`/sports/${sport}/odds`, {
      regions: 'us',
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
    }, { retries: 1, timeoutMs: 2500 });

    if (result.ok) {
      const normalized = normalizeEvents(result.data, 'american');
      const payload = {
        sport,
        markets,
        events: normalized,
        quota: result.quota,
        cachedAt: new Date().toISOString(),
        dataSource: 'live',
        stale: false,
      };
      await cacheSet(cacheKey, payload);

      // ── NBA snapshot logging (fire-and-forget, never blocks response) ──
      maybeLogNbaSnapshot(sport, normalized).catch(() => {});

      res.setHeader('Cache-Control', `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WINDOW_SECONDS}`);
      res.setHeader('X-BetIntel-Source', 'live');
      return res.status(200).json(payload);
    }

    // Provider returned non-200 — try warm cache before failing
    if (cacheIsWarm) {
      res.setHeader('X-BetIntel-Source', 'cache-stale');
      return res.status(200).json({
        ...cached,
        dataSource: 'cache',
        stale: true,
        providerError: { code: result.errorCode, status: result.status },
      });
    }

    // Hard provider failure — no usable cache
    const status = result.errorCode === ERROR_CODES.UNAUTHORIZED ? 401
      : result.errorCode === ERROR_CODES.RATE_LIMIT ? 429
      : result.errorCode === ERROR_CODES.PLAN_LIMIT ? 403
      : 502;

    return res.status(status).json({
      error: 'Odds provider unavailable',
      code: result.errorCode,
      quota: result.quota,
      dataSource: 'none',
    });

  } catch (err) {
    console.error('[api/odds] unexpected error:', err.message);

    if (cacheIsWarm) {
      res.setHeader('X-BetIntel-Source', 'cache-stale');
      return res.status(200).json({
        ...cached,
        dataSource: 'cache',
        stale: true,
        providerError: { code: 'UNEXPECTED', message: err.message },
      });
    }

    return res.status(500).json({ error: 'Internal server error', dataSource: 'none' });
  }
};
