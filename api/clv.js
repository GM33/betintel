// api/clv.js
// BetIntel — Closing Line Value (CLV) Tracker
//
// GET  /api/clv?sport=mlb|nba|wnba&date=2026-06-03&tier=HIGH|MED
// POST /api/clv/snapshot  { gameId, marketKey, selKey, book, point, price, sport }
//
// CLV = how much the line moved in your favor between when BetIntel
//        logged the prediction and closing (game-time) price.
//
// Formula:
//   CLV (pts) = openLine - closePoint   (spread/total: positive = moved your way)
//   CLV (prob) = closeFairProb - openFairProb
//
// Redis keys consumed:
//   mlb:pred:*     — logged by mlb-logger
//   nba:pred:*     — logged by nba-logger
//   wnba:pred:*    — logged by wnba (nba-logger pattern)
//   mlb:daily:{d}  — sorted sets written by mlb-logger
//   nba:daily:{d}  — sorted sets written by nba-logger
//
// Closing line snapshot:
//   CLV only has meaning if we capture the line at game-time.
//   This endpoint also provides a POST /api/clv/snapshot route
//   that the cron jobs call ~5 min before first pitch / tip-off.

'use strict';

let redis;
try { redis = require('./_lib/redis-client'); } catch { redis = null; }

const { noVig } = require('./_lib/no-vig');

const SPORTS = ['mlb', 'nba', 'wnba'];
const CLOSE_SNAP_TTL = 60 * 60 * 72; // 72hr

// ── Helpers ────────────────────────────────────────────────────────────────

function americanToImplied(price) {
  const p = parseInt(price);
  if (!p) return 0.5;
  return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
}

function impliedToAmerican(prob) {
  if (prob <= 0 || prob >= 1) return null;
  return prob >= 0.5
    ? Math.round(-(prob / (1 - prob)) * 100)
    : Math.round(((1 - prob) / prob) * 100);
}

function clvPoints(openPoint, closePoint) {
  if (openPoint == null || closePoint == null) return null;
  return parseFloat((openPoint - closePoint).toFixed(2));
}

function clvProb(openPrice, closePrice) {
  if (!openPrice || !closePrice) return null;
  const openProb  = americanToImplied(openPrice);
  const closeProb = americanToImplied(closePrice);
  return parseFloat((closeProb - openProb).toFixed(4));
}

function closingLineKey(sport, gameId, marketKey, selKey, book) {
  const selNorm = selKey.replace(/\s+/g, '_').slice(0, 60);
  return `${sport}:close:${gameId}:${marketKey}:${selNorm}:${book}`;
}

// ── GET: fetch CLV report for a date ─────────────────────────────────────────

async function getCLVReport(sport, date, tierFilter) {
  if (!redis) return { error: 'Redis unavailable', picks: [] };

  const sportsToQuery = sport === 'all' ? SPORTS : [sport];
  const allRows = [];

  for (const sp of sportsToQuery) {
    const dKey = `${sp}:daily:${date}`;
    let predKeys;
    try {
      // ZREVRANGE: highest edge first
      predKeys = await redis.zrevrange(dKey, 0, 99);
    } catch { continue; }

    for (const pKey of (predKeys || [])) {
      try {
        const pred = await redis.hgetall(pKey);
        if (!pred || !pred.gameId) continue;
        if (tierFilter && pred.confidenceTier !== tierFilter) continue;

        // Look for closing line snapshot
        const selNorm = (pred.selection || '').replace(/\s+/g, '_').slice(0, 60);
        const cKey = closingLineKey(sp, pred.gameId, pred.marketKey, selNorm, pred.book);
        const closeSnap = await redis.hgetall(cKey);

        const openPoint = pred.line !== '' ? parseFloat(pred.line) : null;
        const openPrice = pred.priceAtEval !== '' ? parseInt(pred.priceAtEval) : null;
        const closePoint = closeSnap?.point !== undefined && closeSnap.point !== '' ? parseFloat(closeSnap.point) : null;
        const closePrice = closeSnap?.price !== undefined && closeSnap.price !== '' ? parseInt(closeSnap.price) : null;

        const clvPts  = clvPoints(openPoint, closePoint);
        const clvP    = clvProb(openPrice, closePrice);

        allRows.push({
          sport:          sp,
          game:           `${pred.awayTeam} @ ${pred.homeTeam}`,
          commenceTime:   pred.commenceTime,
          market:         pred.marketType,
          marketKey:      pred.marketKey,
          selection:      pred.selection,
          confidence:     pred.confidenceTier,
          modelEdge:      pred.modelEdge !== '' ? `${parseFloat(pred.modelEdge) > 0 ? '+' : ''}${(parseFloat(pred.modelEdge)*100).toFixed(2)}%` : null,
          openPrice:      openPrice,
          closePrice:     closePrice || null,
          openLine:       openPoint,
          closeLine:      closePoint || null,
          clvPoints:      clvPts,
          clvProb:        clvP != null ? `${clvP > 0 ? '+' : ''}${(clvP * 100).toFixed(2)}%` : null,
          clvStatus:      closeSnap ? (clvPts != null && clvPts > 0 ? 'BEAT' : clvPts != null && clvPts < 0 ? 'MISSED' : 'PUSH') : 'PENDING',
          result:         pred.result || null,
          hit:            pred.hit    || null,
          loggedAt:       pred.loggedAt,
        });
      } catch { continue; }
    }
  }

  // Summary stats
  const resolved  = allRows.filter(r => r.clvStatus !== 'PENDING');
  const beatCLV   = resolved.filter(r => r.clvStatus === 'BEAT').length;
  const beatRate  = resolved.length ? parseFloat((beatCLV / resolved.length * 100).toFixed(1)) : null;

  return {
    date,
    sport,
    total:      allRows.length,
    resolved:   resolved.length,
    pending:    allRows.length - resolved.length,
    beatCLV,
    beatRate:   beatRate != null ? `${beatRate}%` : null,
    picks:      allRows,
  };
}

// ── POST: snapshot closing line ─────────────────────────────────────────────────

async function snapshotClose(body) {
  if (!redis) return { error: 'Redis unavailable' };
  const { sport, gameId, marketKey, selKey, book, point, price } = body;
  if (!sport || !gameId || !marketKey || !selKey || !book) {
    return { error: 'Missing required fields: sport, gameId, marketKey, selKey, book' };
  }
  const cKey = closingLineKey(sport, gameId, marketKey, selKey, book);
  try {
    await redis.hset(cKey, {
      point:      String(point ?? ''),
      price:      String(price ?? ''),
      snappedAt:  new Date().toISOString(),
    });
    await redis.expire(cKey, CLOSE_SNAP_TTL);
    return { ok: true, key: cKey };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // POST /api/clv/snapshot
  if (req.method === 'POST') {
    const result = await snapshotClose(req.body || {});
    return result.error
      ? res.status(400).json(result)
      : res.status(200).json(result);
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST only' });

  const sport      = (req.query.sport || 'all').toLowerCase();
  const date       = req.query.date  || new Date().toISOString().slice(0, 10);
  const tierFilter = (req.query.tier || '').toUpperCase() || null;

  if (!['mlb','nba','wnba','all'].includes(sport)) {
    return res.status(400).json({ error: `Invalid sport. Use: mlb, nba, wnba, all` });
  }

  try {
    const report = await getCLVReport(sport, date, tierFilter);
    return res.status(200).json(report);
  } catch (err) {
    console.error('[clv] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
