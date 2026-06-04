// api/odds.js
// BetIntel live odds endpoint — Redis-backed cache, stale fallback, dataSource flag
// Supports ?sport=all to aggregate across all active sports in parallel

const { fetchOdds, isAllowedSport, sanitizeMarkets, normalizeEvents, getRateLimitState, ERROR_CODES } = require('./_lib/odds');
const { maybeLogNbaSnapshot } = require('./_lib/nba-snapshot-hook');

// Sports fetched when ?sport=all
const ALL_SPORTS = [
  'baseball_mlb',
  'basketball_nba',
  'basketball_wnba',
  'americanfootball_nfl',
  'icehockey_nhl',
  'soccer_epl',
];

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

// ---- Fetch a single sport (used for both single and multi-sport requests) ----
async function fetchSingleSport(sport, markets) {
  const cacheKey = `betintel:odds:${sport}:${markets}`;
  const cached = await cacheGet(cacheKey);
  const cacheAgeMs = cached ? Date.now() - new Date(cached.cachedAt).getTime() : null;
  const cacheIsHot  = cacheAgeMs !== null && cacheAgeMs < CACHE_TTL_SECONDS * 1000;
  const cacheIsWarm = cacheAgeMs !== null && cacheAgeMs < STALE_WINDOW_SECONDS * 1000;

  if (cacheIsHot) return { ...cached, dataSource: 'cache', stale: false };

  const result = await fetchOdds(`/sports/${sport}/odds`, {
    regions: 'us',
    markets,
    oddsFormat: 'american',
    dateFormat: 'iso',
  });

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
    maybeLogNbaSnapshot(sport, normalized).catch(() => {});
    return payload;
  }

  if (cacheIsWarm) return { ...cached, dataSource: 'cache', stale: true };
  return { sport, events: [], dataSource: 'error', errorCode: result.errorCode };
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sport   = String(req.query.sport || 'all');
  const markets = sanitizeMarkets(req.query.markets || 'h2h,spreads,totals');

  // ---- Multi-sport aggregation for ?sport=all ----
  if (sport === 'all') {
    try {
      const results = await Promise.all(ALL_SPORTS.map((s) => fetchSingleSport(s, markets)));
      const allEvents = results.flatMap((r) => (r.events || []));
      const quota = results.find((r) => r.quota)?.quota || getRateLimitState();
      res.setHeader('Cache-Control', `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WINDOW_SECONDS}`);
      res.setHeader('X-BetIntel-Source', 'multi-live');
      return res.status(200).json({
        sport: 'all',
        markets,
        events: allEvents,
        perSport: results.map((r) => ({ sport: r.sport, count: (r.events || []).length, dataSource: r.dataSource })),
        quota,
        cachedAt: new Date().toISOString(),
        dataSource: 'live',
        stale: false,
      });
    } catch (err) {
      console.error('[api/odds] multi-sport error:', err.message);
      return res.status(500).json({ error: 'Internal server error', dataSource: 'none' });
    }
  }

  // ---- Single sport ----
  if (!isAllowedSport(sport)) {
    return res.status(400).json({
      error: 'Unsupported sport',
      allowed: ALL_SPORTS,
    });
  }

  try {
    const payload = await fetchSingleSport(sport, markets);
    if (payload.dataSource === 'error') {
      const status = payload.errorCode === ERROR_CODES.UNAUTHORIZED ? 401
        : payload.errorCode === ERROR_CODES.RATE_LIMIT ? 429
        : payload.errorCode === ERROR_CODES.PLAN_LIMIT ? 403
        : 502;
      return res.status(status).json({ error: 'Odds provider unavailable', code: payload.errorCode, dataSource: 'none' });
    }
    const sourceHeader = payload.stale ? 'cache-stale' : payload.dataSource === 'cache' ? 'cache-hot' : 'live';
    res.setHeader('Cache-Control', `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WINDOW_SECONDS}`);
    res.setHeader('X-BetIntel-Source', sourceHeader);
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[api/odds] unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error', dataSource: 'none' });
  }
};
