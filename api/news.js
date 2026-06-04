// api/news.js
// BetIntel — Sports News Feed Endpoint
//
// GET /api/news?sport=mlb|nba|nfl|wnba|tennis|all&team=NYY&limit=20
//
// Flow:
//   1. Fetch headlines from NewsAPI (sports category) + GNews fallback
//   2. Match each article to a live game from Redis (odds cache) if possible
//   3. Attach odds pill (ML / spread / total) when game matched
//   4. Return sorted feed: breaking > matched > general
//
// Redis keys consumed (read-only):
//   odds:live:{sport}          — set by cron jobs, used for game matching
//
// Env vars required:
//   NEWS_API_KEY               — newsapi.org key
//   GNEWS_API_KEY              — gnews.io key (fallback)

'use strict';

const https = require('https');

let redis;
try { redis = require('./_lib/redis-client'); } catch { redis = null; }

// ── Config ────────────────────────────────────────────────────────────────

const NEWS_API_KEY  = process.env.NEWS_API_KEY  || '';
const GNEWS_KEY     = process.env.GNEWS_API_KEY || '';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;
const CACHE_TTL     = 300; // 5 min news cache

const SPORT_QUERIES = {
  mlb:    'MLB baseball',
  nba:    'NBA basketball',
  nfl:    'NFL football',
  wnba:   'WNBA basketball',
  tennis: 'tennis ATP WTA',
  all:    'MLB NBA NFL WNBA sports betting',
};

const SPORT_REDIS_KEY = {
  mlb:  'odds:live:baseball_mlb',
  nba:  'odds:live:basketball_nba',
  nfl:  'odds:live:americanfootball_nfl',
  wnba: 'odds:live:basketball_wnba',
};

// ── HTTP helper ────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

// ── NewsAPI fetch ───────────────────────────────────────────────────────────

async function fetchNewsAPI(query, limit) {
  if (!NEWS_API_KEY) return [];
  const q   = encodeURIComponent(query);
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=${limit}&apiKey=${NEWS_API_KEY}`;
  try {
    const data = await fetchJSON(url);
    if (data.status !== 'ok') return [];
    return (data.articles || []).map(a => ({
      title:       a.title,
      description: a.description,
      url:         a.url,
      source:      a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt,
      image:       a.urlToImage || null,
      provider:    'newsapi',
    }));
  } catch { return []; }
}

// ── GNews fallback ────────────────────────────────────────────────────────────

async function fetchGNews(query, limit) {
  if (!GNEWS_KEY) return [];
  const q   = encodeURIComponent(query);
  const url = `https://gnews.io/api/v4/search?q=${q}&lang=en&max=${Math.min(limit, 10)}&token=${GNEWS_KEY}`;
  try {
    const data = await fetchJSON(url);
    return (data.articles || []).map(a => ({
      title:       a.title,
      description: a.description,
      url:         a.url,
      source:      a.source?.name || 'GNews',
      publishedAt: a.publishedAt,
      image:       a.image || null,
      provider:    'gnews',
    }));
  } catch { return []; }
}

// ── Game matcher: tries to link article to a live game in Redis ──────────────────

async function matchGame(article, sport) {
  if (!redis) return null;
  const rKey = SPORT_REDIS_KEY[sport];
  if (!rKey) return null;
  try {
    const raw = await redis.get(rKey);
    if (!raw) return null;
    const events = JSON.parse(raw);
    const text   = `${article.title} ${article.description || ''}`.toLowerCase();
    for (const ev of events) {
      const home = (ev.home_team || '').toLowerCase();
      const away = (ev.away_team || '').toLowerCase();
      const homeWords = home.split(' ');
      const awayWords = away.split(' ');
      const homeLast  = homeWords[homeWords.length - 1];
      const awayLast  = awayWords[awayWords.length - 1];
      if (
        text.includes(homeLast) || text.includes(awayLast) ||
        text.includes(home)     || text.includes(away)
      ) {
        // Pull best available odds pill from DraftKings
        const dk = (ev.bookmakers || []).find(b => b.key === 'draftkings');
        if (!dk) return { gameId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time, odds: null };
        const h2h = (dk.markets || []).find(m => m.key === 'h2h');
        const odds = h2h ? {
          home: h2h.outcomes.find(o => o.name === ev.home_team)?.price ?? null,
          away: h2h.outcomes.find(o => o.name === ev.away_team)?.price ?? null,
        } : null;
        return { gameId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time, odds };
      }
    }
  } catch { return null; }
  return null;
}

// ── Dedup by URL ──────────────────────────────────────────────────────────────

function dedup(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// ── Handler ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sport  = (req.query.sport || 'all').toLowerCase();
  const team   = (req.query.team  || '').toLowerCase();
  const limit  = Math.min(parseInt(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  // Redis cache check
  const cacheKey = `news:feed:${sport}:${team}:${limit}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {}
  }

  let query = SPORT_QUERIES[sport] || SPORT_QUERIES.all;
  if (team) query = `${team} ${query}`;

  // Fetch from both providers in parallel
  const [newsApiArticles, gnewsArticles] = await Promise.all([
    fetchNewsAPI(query, limit),
    fetchGNews(query, Math.ceil(limit / 2)),
  ]);

  let articles = dedup([...newsApiArticles, ...gnewsArticles])
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);

  // Game matching (parallel)
  const matched = await Promise.all(
    articles.map(async (article) => {
      const game = await matchGame(article, sport);
      return { ...article, matchedGame: game || null };
    })
  );

  // Sort: matched-with-odds first, then matched-no-odds, then general
  matched.sort((a, b) => {
    const scoreA = a.matchedGame?.odds ? 2 : a.matchedGame ? 1 : 0;
    const scoreB = b.matchedGame?.odds ? 2 : b.matchedGame ? 1 : 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    sport,
    team:        team || null,
    total:       matched.length,
    matchedGames: matched.filter(a => a.matchedGame).length,
    articles:    matched,
  };

  // Cache result
  if (redis) {
    try { await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(payload)); } catch {}
  }

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(payload);
};
