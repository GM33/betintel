// api/mlb-cron.js
// BetIntel — MLB Cron Job
//
// Mirrors nba-cron.js exactly. Called by Railway cron every 10 minutes.
//
// Actions:
//   1. Fetch live MLB odds for all active markets
//   2. Snapshot opening lines (first-seen per selection) via mlb-logger
//   3. Cache full event payload to Redis: odds:live:baseball_mlb
//   4. Run mlb-model evaluateAll() and cache HIGH/MED picks: mlb:picks:current
//   5. Log new HIGH/MED predictions that haven’t been logged yet
//
// Env vars: ODDS_API_KEY, REDIS_URL

'use strict';

const { fetchOdds, sanitizeMarkets, normalizeEvents } = require('./_lib/odds');
const { evaluateAll }    = require('./_lib/mlb-model');
const { logPrediction, snapshotOpenLine, getOpenClose } = require('./_lib/mlb-logger');

let redis;
try { redis = require('./_lib/redis-client'); } catch { redis = null; }

const SPORT           = 'baseball_mlb';
const REDIS_LIVE_KEY  = 'odds:live:baseball_mlb';
const REDIS_PICKS_KEY = 'mlb:picks:current';
const CACHE_TTL       = 900; // 15 min
const DEFAULT_MARKETS = 'h2h,spreads,totals,batter_home_runs,batter_hits,batter_rbis,pitcher_strikeouts,pitcher_outs';

async function snapshotAllOpenLines(events) {
  for (const ev of events) {
    for (const book of (ev.bookmakers || [])) {
      if (book.key !== 'draftkings') continue;
      for (const mkt of (book.markets || [])) {
        for (const o of (mkt.outcomes || [])) {
          const selKey = `${o.description || o.name}:${o.point ?? ''}`;
          await snapshotOpenLine(ev.id, mkt.key, selKey, book.key, o.point ?? null, o.price);
        }
      }
    }
  }
}

async function buildOpenLines(events) {
  const openLines = {};
  for (const ev of events) {
    openLines[ev.id] = {};
    for (const book of (ev.bookmakers || [])) {
      if (book.key !== 'draftkings') continue;
      for (const mkt of (book.markets || [])) {
        openLines[ev.id][mkt.key] = openLines[ev.id][mkt.key] || {};
        for (const o of (mkt.outcomes || [])) {
          const selKey = `${o.description || o.name}:${o.point ?? ''}`;
          const oc = await getOpenClose(ev.id, mkt.key, selKey, 'draftkings');
          if (oc?.open) openLines[ev.id][mkt.key][selKey] = { point: oc.open.point, price: oc.open.price };
        }
      }
    }
  }
  return openLines;
}

module.exports = async function handler(req, res) {
  // Accept Railway cron (GET) or internal POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  const startedAt = Date.now();
  const log = [];

  try {
    // 1. Fetch live odds
    const markets = sanitizeMarkets(DEFAULT_MARKETS);
    const result  = await fetchOdds(`/sports/${SPORT}/odds`, {
      regions: 'us', markets, oddsFormat: 'american', dateFormat: 'iso',
    }, { retries: 2, timeoutMs: 8000 });

    if (!result.ok) {
      return res.status(502).json({ error: 'Odds provider unavailable', code: result.errorCode });
    }

    const events = normalizeEvents(result.data, 'american');
    log.push(`events=${events.length}`);

    // 2. Snapshot opening lines
    await snapshotAllOpenLines(events);
    log.push('openLines=snapshotted');

    // 3. Cache raw events
    if (redis && events.length) {
      await redis.setex(REDIS_LIVE_KEY, CACHE_TTL, JSON.stringify(events));
      log.push(`redis:live=cached (ttl=${CACHE_TTL}s)`);
    }

    // 4. Run model
    const openLines = await buildOpenLines(events);
    const allPreds  = evaluateAll(events, openLines);
    const topPicks  = allPreds
      .filter(p => p.confidenceTier !== 'LOW' && Math.abs(p.modelEdge) > 0.01)
      .sort((a, b) => Math.abs(b.modelEdge) - Math.abs(a.modelEdge))
      .slice(0, 50);
    log.push(`picks:total=${allPreds.length} picks:top=${topPicks.length}`);

    // 5. Cache top picks
    if (redis && topPicks.length) {
      await redis.setex(REDIS_PICKS_KEY, CACHE_TTL, JSON.stringify(topPicks));
      log.push('redis:picks=cached');
    }

    // 6. Log predictions (fire-and-forget)
    Promise.all(topPicks.map(p => logPrediction(p)))
      .catch(err => console.warn('[mlb-cron] log error:', err.message));

    const elapsed = Date.now() - startedAt;
    return res.status(200).json({
      ok: true,
      sport: SPORT,
      events: events.length,
      topPicks: topPicks.length,
      quota: result.quota,
      elapsed: `${elapsed}ms`,
      log,
    });

  } catch (err) {
    console.error('[mlb-cron] error:', err.message);
    return res.status(500).json({ error: err.message, log });
  }
};
