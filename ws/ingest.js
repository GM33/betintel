/**
 * ws/ingest.js
 * BetIntel Ingest Worker
 *
 * Runs on a separate process (cron or loop):
 *  1. Fetches latest odds from The Odds API
 *  2. Diffs against previous snapshot stored in Redis
 *  3. Writes new snapshot to Redis
 *  4. Publishes delta to Redis Pub/Sub channel
 *     -> ws/server.js picks it up and broadcasts to subscribed clients
 *
 * Env vars:
 *  REDIS_URL               — Redis connection
 *  ODDS_API_KEY            — The Odds API key
 *  ODDS_API_BASE_URL       — (optional) override base URL
 *  BETINTEL_ALLOWED_SPORTS — comma-separated sports to ingest
 *  INGEST_INTERVAL_MS      — poll interval (default 20000ms)
 *  INGEST_MARKETS          — comma-separated markets (default h2h,spreads)
 *  ODDS_STALE_WINDOW_SECONDS — Redis TTL for snapshot (default 120s)
 */

'use strict';

const Redis = require('ioredis');

const BASE_URL      = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const INTERVAL_MS   = Number(process.env.INGEST_INTERVAL_MS || 20000);
const STALE_TTL     = Number(process.env.ODDS_STALE_WINDOW_SECONDS || 120);
const MARKETS       = process.env.INGEST_MARKETS || 'h2h,spreads';
const SPORTS        = (process.env.BETINTEL_ALLOWED_SPORTS ||
  'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl')
  .split(',').map(s => s.trim()).filter(Boolean);

const redis = new Redis(process.env.REDIS_URL);
redis.on('error', err => console.error('[redis:ingest]', err.message));

// ── Rate-limit state ──────────────────────────────────────────────────────────
let quotaRemaining = null;
let lastQuotaCheck = null;

// ── Odds fetch ────────────────────────────────────────────────────────────────
async function fetchSportOdds(sport) {
  const url = new URL(`${BASE_URL}/sports/${sport}/odds`);
  url.searchParams.set('apiKey',     process.env.ODDS_API_KEY);
  url.searchParams.set('regions',    'us');
  url.searchParams.set('markets',    MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 3000);

  try {
    const res  = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal:  controller.signal,
    });
    clearTimeout(timeout);

    quotaRemaining = Number(res.headers.get('x-requests-remaining') ?? quotaRemaining);
    lastQuotaCheck = new Date().toISOString();

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ingest] ${sport} HTTP ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[ingest] fetch error for ${sport}:`, err.message);
    return null;
  }
}

// ── Delta computation ─────────────────────────────────────────────────────────
// Returns array of changed outcomes (event id + bookmaker + market + outcome)
function computeDeltas(prevEvents, nextEvents) {
  if (!prevEvents || !prevEvents.length) return null; // first run — no delta, full snapshot

  const prevMap = new Map();
  for (const ev of prevEvents) prevMap.set(ev.id, ev);

  const deltas = [];

  for (const ev of nextEvents) {
    const prev = prevMap.get(ev.id);
    for (const bm of (ev.bookmakers || [])) {
      for (const mkt of (bm.markets || [])) {
        for (const o of (mkt.outcomes || [])) {
          // Find matching previous outcome
          const prevPrice = prev
            ? prev.bookmakers?.find(b => b.key === bm.key)
                ?.markets?.find(m => m.key === mkt.key)
                ?.outcomes?.find(x => x.name === o.name)?.price
            : undefined;

          if (prevPrice !== o.price) {
            deltas.push({
              eventId:   ev.id,
              homeTeam:  ev.home_team,
              awayTeam:  ev.away_team,
              commence:  ev.commence_time,
              book:      bm.key,
              bookTitle: bm.title,
              market:    mkt.key,
              outcome:   o.name,
              price:     o.price,
              prevPrice: prevPrice ?? null,
              point:     o.point ?? null,
            });
          }
        }
      }
    }
  }

  return deltas;
}

// ── Normalization (matches api/odds.js shape) ─────────────────────────────────
function normalizeEvents(raw) {
  return (raw || []).map(ev => ({
    id:          String(ev.id || ''),
    sportKey:    String(ev.sport_key || ''),
    sportTitle:  String(ev.sport_title || ''),
    commenceTime: String(ev.commence_time || ''),
    homeTeam:    String(ev.home_team || ''),
    awayTeam:    String(ev.away_team || ''),
    bookmakers:  (ev.bookmakers || []).map(bm => ({
      bookmakerKey: String(bm.key || ''),
      title:        String(bm.title || ''),
      lastUpdate:   String(bm.last_update || ''),
      markets: (bm.markets || []).map(m => ({
        marketKey: String(m.key || ''),
        outcomes:  (m.outcomes || []).map(o => ({
          name:  String(o.name || ''),
          price: Number(o.price ?? NaN),
          point: o.point != null ? Number(o.point) : null,
        })),
      })),
    })),
  }));
}

// ── Main ingest loop ──────────────────────────────────────────────────────────
async function ingestSport(sport) {
  const cacheKey   = `betintel:odds:${sport}:h2h`;
  const deltaChannel = `betintel:delta:${sport}`;

  const raw = await fetchSportOdds(sport);
  if (!raw) return;  // fetch failed — keep existing cache

  const events = normalizeEvents(raw);

  // Load previous snapshot from Redis
  let prevEvents = null;
  try {
    const prev = await redis.get(cacheKey);
    if (prev) {
      const parsed = JSON.parse(prev);
      prevEvents = parsed.events || null;
    }
  } catch { /* first run */ }

  // Compute deltas
  const deltas = computeDeltas(prevEvents, events);

  // Write snapshot
  const snapshot = {
    sport,
    markets:    MARKETS,
    events,
    dataSource: 'live',
    stale:      false,
    cachedAt:   new Date().toISOString(),
    quota:      { remaining: quotaRemaining, updatedAt: lastQuotaCheck },
  };
  await redis.set(cacheKey, JSON.stringify(snapshot), 'EX', STALE_TTL);

  // Publish delta if there are changes
  if (deltas && deltas.length > 0) {
    const msg = JSON.stringify({
      sport,
      updatedAt: snapshot.cachedAt,
      deltaCount: deltas.length,
      deltas,
    });
    await redis.publish(deltaChannel, msg);
    console.log(`[ingest] ${sport}: ${deltas.length} delta(s) published, quota=${quotaRemaining}`);
  } else if (!prevEvents) {
    // First ingest — no delta but snapshot is now warm; notify clients to subscribe
    await redis.publish(deltaChannel, JSON.stringify({
      sport,
      updatedAt: snapshot.cachedAt,
      deltaCount: 0,
      deltas: [],
      initialSnapshot: true,
    }));
    console.log(`[ingest] ${sport}: initial snapshot written`);
  } else {
    console.log(`[ingest] ${sport}: no changes, quota=${quotaRemaining}`);
  }
}

async function ingestAll() {
  await Promise.allSettled(SPORTS.map(ingestSport));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[betintel-ingest] starting — sports: ${SPORTS.join(', ')}`);
  console.log(`[betintel-ingest] interval: ${INTERVAL_MS}ms, markets: ${MARKETS}`);

  // First run immediately
  await ingestAll();

  // Then on interval
  setInterval(async () => {
    try { await ingestAll(); }
    catch (err) { console.error('[ingest] loop error:', err.message); }
  }, INTERVAL_MS);
})()
.catch(err => {
  console.error('[betintel-ingest] fatal:', err);
  process.exit(1);
});
