// api/news.js
// BetIntel — Sports News Feed Endpoint
//
// GET /api/news?sport=mlb|nba|nfl|wnba|tennis|all&team=NYY&limit=20
//
// Fixes applied:
//   - CORS headers on every response (including 4xx/5xx)
//   - fetchJSON hard timeout (8s) — prevents Railway dyno hang
//   - In-memory LRU fallback when Redis is unavailable
//   - Multi-sport game matching when sport=all
//   - Tennis Redis key added
//   - Graceful error payload when both API keys are missing
//   - X-Cache, X-Generated-At, Cache-Control headers for frontend ETags
//   - Dedup by normalized title (catches same story from two providers)

'use strict';

const https = require('https');

// ── Redis (optional) ──────────────────────────────────────────────────────
let redis = null;
try { redis = require('./_lib/redis-client'); } catch {}

// ── In-memory fallback cache (when Redis is down) ─────────────────────────
const MEM_CACHE     = new Map();
const MEM_CACHE_TTL = 300_000; // 5 min ms
const MEM_MAX_KEYS  = 50;

function memGet(key) {
  const entry = MEM_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > MEM_CACHE_TTL) { MEM_CACHE.delete(key); return null; }
  return entry.val;
}
function memSet(key, val) {
  if (MEM_CACHE.size >= MEM_MAX_KEYS) {
    // evict oldest
    const oldest = [...MEM_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) MEM_CACHE.delete(oldest[0]);
  }
  MEM_CACHE.set(key, { val, ts: Date.now() });
}

// ── Config ────────────────────────────────────────────────────────────────
const NEWS_API_KEY  = process.env.NEWS_API_KEY  || '';
const GNEWS_KEY     = process.env.GNEWS_API_KEY || '';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;
const CACHE_TTL_S   = 300;          // Redis TTL seconds
const FETCH_TIMEOUT = 8_000;        // ms — hard cap per external request

const SPORT_QUERIES = {
  mlb:    'MLB baseball',
  nba:    'NBA basketball',
  nfl:    'NFL football',
  wnba:   'WNBA basketball',
  tennis: 'tennis ATP WTA tournament',
  all:    'MLB NBA NFL WNBA sports betting odds',
};

// All Redis keys to try for game matching
const SPORT_REDIS_KEYS = {
  mlb:    ['odds:live:baseball_mlb'],
  nba:    ['odds:live:basketball_nba'],
  nfl:    ['odds:live:americanfootball_nfl'],
  wnba:   ['odds:live:basketball_wnba'],
  tennis: ['odds:live:tennis_atp', 'odds:live:tennis_wta'],
  all:    [
    'odds:live:baseball_mlb',
    'odds:live:basketball_nba',
    'odds:live:americanfootball_nfl',
    'odds:live:basketball_wnba',
    'odds:live:tennis_atp',
    'odds:live:tennis_wta',
  ],
};

// ── CORS helper ───────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── fetchJSON with hard timeout ────────────────────────────────────────────
function fetchJSON(url, timeoutMs = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + url)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Timeout: ' + url));
    });
  });
}

// ── NewsAPI ────────────────────────────────────────────────────────────────
async function fetchNewsAPI(query, limit) {
  if (!NEWS_API_KEY) return [];
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=${limit}&apiKey=${NEWS_API_KEY}`;
  try {
    const data = await fetchJSON(url);
    if (data.status !== 'ok') return [];
    return (data.articles || []).map(a => ({
      title:       a.title        || '',
      description: a.description  || '',
      url:         a.url          || '',
      source:      a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt  || null,
      image:       a.urlToImage   || null,
      provider:    'newsapi',
    }));
  } catch { return []; }
}

// ── GNews fallback ─────────────────────────────────────────────────────────
async function fetchGNews(query, limit) {
  if (!GNEWS_KEY) return [];
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=${Math.min(limit, 10)}&token=${GNEWS_KEY}`;
  try {
    const data = await fetchJSON(url);
    return (data.articles || []).map(a => ({
      title:       a.title        || '',
      description: a.description  || '',
      url:         a.url          || '',
      source:      a.source?.name || 'GNews',
      publishedAt: a.publishedAt  || null,
      image:       a.image        || null,
      provider:    'gnews',
    }));
  } catch { return []; }
}

// ── Game matcher ───────────────────────────────────────────────────────────
// Tries every relevant Redis key for the given sport.
// Falls back to in-memory odds cache if Redis is down.
async function matchGame(article, sport) {
  const keys = SPORT_REDIS_KEYS[sport] || [];
  if (!keys.length) return null;

  const text = `${article.title} ${article.description || ''}`.toLowerCase();

  for (const rKey of keys) {
    let raw = null;

    // Try Redis first, then in-memory odds snapshot
    if (redis) {
      try { raw = await redis.get(rKey); } catch {}
    }
    if (!raw) {
      const mem = memGet('odds:' + rKey);
      if (mem) raw = JSON.stringify(mem);
    }
    if (!raw) continue;

    let events;
    try { events = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(events)) continue;

    for (const ev of events) {
      const home      = (ev.home_team || '').toLowerCase();
      const away      = (ev.away_team || '').toLowerCase();
      const homeLast  = home.split(' ').pop();
      const awayLast  = away.split(' ').pop();

      const matched =
        (homeLast.length > 2 && text.includes(homeLast)) ||
        (awayLast.length > 2 && text.includes(awayLast)) ||
        text.includes(home) || text.includes(away);

      if (!matched) continue;

      // Pull DraftKings odds, fall back to first available book
      const book =
        (ev.bookmakers || []).find(b => b.key === 'draftkings') ||
        ev.bookmakers?.[0];

      if (!book) {
        return { gameId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time, odds: null };
      }

      const h2h  = (book.markets || []).find(m => m.key === 'h2h');
      const odds = h2h ? {
        home: h2h.outcomes.find(o => o.name === ev.home_team)?.price ?? null,
        away: h2h.outcomes.find(o => o.name === ev.away_team)?.price ?? null,
      } : null;

      return {
        gameId:      ev.id,
        homeTeam:    ev.home_team,
        awayTeam:    ev.away_team,
        commenceTime: ev.commence_time,
        odds,
      };
    }
  }
  return null;
}

// ── Dedup by URL + normalized title ────────────────────────────────────────
function dedup(articles) {
  const seenUrls   = new Set();
  const seenTitles = new Set();
  return articles.filter(a => {
    if (!a.url && !a.title) return false;
    const titleKey = (a.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seenUrls.has(a.url) || seenTitles.has(titleKey)) return false;
    if (a.url)      seenUrls.add(a.url);
    if (titleKey)   seenTitles.add(titleKey);
    return true;
  });
}

// ── Cache helpers (Redis + in-mem) ─────────────────────────────────────────
async function cacheGet(key) {
  if (redis) {
    try {
      const v = await redis.get(key);
      if (v) return JSON.parse(v);
    } catch {}
  }
  return memGet(key);
}
async function cacheSet(key, val) {
  if (redis) {
    try { await redis.setex(key, CACHE_TTL_S, JSON.stringify(val)); return; } catch {}
  }
  memSet(key, val);
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  // No API keys configured — return clear error so Railway logs show root cause
  if (!NEWS_API_KEY && !GNEWS_KEY) {
    return res.status(503).json({
      error:   'news_keys_missing',
      message: 'Set NEWS_API_KEY and/or GNEWS_API_KEY in Railway environment variables.',
      articles: [],
    });
  }

  const sport  = (req.query.sport || 'all').toLowerCase();
  const team   = (req.query.team  || '').trim().toLowerCase();
  const limit  = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const cacheKey = `news:feed:${sport}:${team}:${limit}`;

  // Cache check
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache',        'HIT');
    res.setHeader('Cache-Control',  `public, max-age=${CACHE_TTL_S}`);
    res.setHeader('X-Generated-At', cached.generatedAt || '');
    return res.status(200).json(cached);
  }

  // Build query
  let query = SPORT_QUERIES[sport] || SPORT_QUERIES.all;
  if (team) query = `${team} ${query}`;

  // Fetch both providers in parallel
  const [newsApiArticles, gnewsArticles] = await Promise.all([
    fetchNewsAPI(query, limit),
    fetchGNews(query, Math.ceil(limit / 2)),
  ]);

  let articles = dedup([...newsApiArticles, ...gnewsArticles])
    .filter(a => a.title && a.url)            // drop tombstoned/removed articles
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);

  // Game matching (parallel, best-effort)
  const matched = await Promise.all(
    articles.map(async (article) => {
      try {
        const game = await matchGame(article, sport);
        return { ...article, matchedGame: game || null };
      } catch {
        return { ...article, matchedGame: null };
      }
    })
  );

  // Sort: game-with-odds > game-no-odds > general; ties broken by recency
  matched.sort((a, b) => {
    const sa = a.matchedGame?.odds ? 2 : a.matchedGame ? 1 : 0;
    const sb = b.matchedGame?.odds ? 2 : b.matchedGame ? 1 : 0;
    if (sb !== sa) return sb - sa;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  const payload = {
    generatedAt:  new Date().toISOString(),
    sport,
    team:         team || null,
    total:        matched.length,
    matchedGames: matched.filter(a => a.matchedGame).length,
    articles:     matched,
  };

  await cacheSet(cacheKey, payload);

  res.setHeader('X-Cache',        'MISS');
  res.setHeader('Cache-Control',  `public, max-age=${CACHE_TTL_S}`);
  res.setHeader('X-Generated-At', payload.generatedAt);
  return res.status(200).json(payload);
};
