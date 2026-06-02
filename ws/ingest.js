/**
 * ws/ingest.js
 * BetIntel Ingest Worker
 *
 * Fixes applied (audit):
 *  #2  — Quota burnout: default interval 120s, hard pause when quota < 20
 *  #7  — Delta key mismatch: look up by bookmakerKey (normalized field) not bm.key
 */

'use strict';

const Redis = require('ioredis');

const BASE_URL    = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS || 120_000); // FIX #2: was 20000
const STALE_TTL   = Number(process.env.ODDS_STALE_WINDOW_SECONDS || 180);
const MARKETS     = process.env.INGEST_MARKETS || 'h2h,spreads';
const SPORTS      = (process.env.BETINTEL_ALLOWED_SPORTS ||
  'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl')
  .split(',').map(s => s.trim()).filter(Boolean);

const QUOTA_PAUSE_THRESHOLD = Number(process.env.QUOTA_PAUSE_THRESHOLD || 20); // FIX #2

const redis = new Redis(process.env.REDIS_URL);
redis.on('error', err => console.error('[redis:ingest]', err.message));

// ── Rate-limit state ──────────────────────────────────────────────────────────
let quotaRemaining = null;
let lastQuotaCheck = null;
let quotaPaused    = false;

// ── Odds fetch ────────────────────────────────────────────────────────────────
async function fetchSportOdds(sport) {
  // FIX #2: hard stop when quota is near zero
  if (quotaPaused) {
    console.warn(`[ingest] QUOTA PAUSED (remaining=${quotaRemaining}) — skipping ${sport}`);
    return null;
  }

  const url = new URL(`${BASE_URL}/sports/${sport}/odds`);
  url.searchParams.set('apiKey',     process.env.ODDS_API_KEY);
  url.searchParams.set('regions',    'us');
  url.searchParams.set('markets',    MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal:  controller.signal,
    });
    clearTimeout(timeout);

    const remaining = Number(res.headers.get('x-requests-remaining') ?? quotaRemaining);
    quotaRemaining  = isNaN(remaining) ? quotaRemaining : remaining;
    lastQuotaCheck  = new Date().toISOString();

    // FIX #2: engage pause flag when near quota limit
    if (quotaRemaining !== null && quotaRemaining < QUOTA_PAUSE_THRESHOLD) {
      quotaPaused = true;
      console.warn(`[ingest] Quota low (${quotaRemaining} remaining) — pausing all fetches. Set QUOTA_PAUSE_THRESHOLD to override.`);
    }

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

// ── Delta computation — FIX #7 ────────────────────────────────────────────────
// normalizeEvents() stores bookmakers as { bookmakerKey, ... } not { key, ... }
// Previous bug: looked up bm.key → always undefined → every run was a full delta flood
function computeDeltas(prevEvents, nextEvents) {
  if (!prevEvents || !prevEvents.length) return null; // first run — no delta

  const prevMap = new Map();
  for (const ev of prevEvents) prevMap.set(ev.id, ev);

  const deltas = [];

  for (const ev of nextEvents) {
    const prev = prevMap.get(ev.id);
    for (const bm of (ev.bookmakers || [])) {
      for (const mkt of (bm.markets || [])) {
        for (const o of (mkt.outcomes || [])) {
          // FIX #7: use bookmakerKey (normalized) and marketKey (normalized)
          const prevPrice = prev
            ? prev.bookmakers?.find(b => b.bookmakerKey === bm.bookmakerKey)
                ?.markets?.find(m => m.marketKey === mkt.marketKey)
                ?.outcomes?.find(x => x.name === o.name)?.price
            : undefined;

          if (prevPrice !== o.price) {
            deltas.push({
              eventId:   ev.id,
              homeTeam:  ev.homeTeam,
              awayTeam:  ev.awayTeam,
              commence:  ev.commenceTime,
              book:      bm.bookmakerKey,
              bookTitle: bm.title,
              market:    mkt.marketKey,
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

// ── Normalization (matches api/_lib/odds.js shape) ─────────────────────────────
function normalizeEvents(raw) {
  return (raw || []).map(ev => ({
    id:           String(ev.id || ''),
    sportKey:     String(ev.sport_key || ''),
    sportTitle:   String(ev.sport_title || ''),
    commenceTime: String(ev.commence_time || ''),
    homeTeam:     String(ev.home_team || ''),
    awayTeam:     String(ev.away_team || ''),
    bookmakers:   (ev.bookmakers || []).map(bm => ({
      bookmakerKey: String(bm.key || ''),  // normalized field name
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
  const cacheKey     = `betintel:odds:${sport}:h2h`;
  const deltaChannel = `betintel:delta:${sport}`;

  const raw = await fetchSportOdds(sport);
  if (!raw) return;

  const events = normalizeEvents(raw);

  let prevEvents = null;
  try {
    const prev = await redis.get(cacheKey);
    if (prev) prevEvents = JSON.parse(prev).events || null;
  } catch { /* first run */ }

  const deltas = computeDeltas(prevEvents, events);

  const snapshot = {
    sport, markets: MARKETS, events,
    dataSource: 'live', stale: false,
    cachedAt: new Date().toISOString(),
    quota: { remaining: quotaRemaining, updatedAt: lastQuotaCheck },
  };
  await redis.set(cacheKey, JSON.stringify(snapshot), 'EX', STALE_TTL);

  if (deltas && deltas.length > 0) {
    await redis.publish(deltaChannel, JSON.stringify({
      sport, updatedAt: snapshot.cachedAt,
      deltaCount: deltas.length, deltas,
    }));
    console.log(`[ingest] ${sport}: ${deltas.length} delta(s) published, quota=${quotaRemaining}`);
  } else if (!prevEvents) {
    // FIX #8 (server side): publish initialSnapshot so clients know to request snapshot
    await redis.publish(deltaChannel, JSON.stringify({
      sport, updatedAt: snapshot.cachedAt,
      deltaCount: 0, deltas: [], initialSnapshot: true,
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
  console.log(`[betintel-ingest] quota pause threshold: ${QUOTA_PAUSE_THRESHOLD} requests remaining`);

  await ingestAll();

  setInterval(async () => {
    try { await ingestAll(); }
    catch (err) { console.error('[ingest] loop error:', err.message); }
  }, INTERVAL_MS);
})().catch(err => {
  console.error('[betintel-ingest] fatal:', err);
  process.exit(1);
});
