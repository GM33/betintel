// api/_lib/nba-logger.js
// BetIntel — NBA Odds Snapshot + Prediction Logger
//
// Hooks into the existing odds polling cycle (api/odds.js) and the NBA
// model evaluation pass to persist:
//
//   1. nba:snapshots:{gameId}:{market}:{selection}  — raw odds over time
//   2. nba:predictions:log                          — model predictions LIST
//   3. nba:predictions:{predId}                     — individual HASH
//   4. nba:predictions:pending                      — SET awaiting resolution
//
// Closing line is derived lazily: the last snapshot with ts < commence_time.

'use strict';

const crypto = require('crypto');

let _redis = null;

async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', () => { _redis = null; });
    await client.connect();
    _redis = client;
    return _redis;
  } catch {
    return null;
  }
}

// ─── 1. Odds Snapshot Logger ──────────────────────────────────────────────────
// Call this inside api/odds.js after a successful live fetch for basketball_nba.
//
// events: normalizeEvents() output from _lib/odds.js
// Each event has: { id, commence_time, home_team, away_team, bookmakers[] }

async function logOddsSnapshot(events) {
  const redis = await getRedis();
  if (!redis || !Array.isArray(events)) return;

  const now = Date.now();
  const pipe = redis.multi();

  for (const ev of events) {
    const gameId = ev.id;
    const commenceTs = new Date(ev.commence_time).getTime();
    if (!gameId) continue;

    // Store lightweight game meta (idempotent HSET — only writes missing fields)
    const metaKey = `nba:game:${gameId}`;
    pipe.hSetNX(metaKey, 'gameId',        gameId);
    pipe.hSetNX(metaKey, 'commence_time', ev.commence_time);
    pipe.hSetNX(metaKey, 'home_team',     ev.home_team);
    pipe.hSetNX(metaKey, 'away_team',     ev.away_team);
    pipe.expire(metaKey, 60 * 60 * 24 * 14); // 14 days

    for (const book of (ev.bookmakers || [])) {
      if (book.key !== 'draftkings' && book.key !== 'fanduel' && book.key !== 'betmgm') continue;

      for (const mkt of (book.markets || [])) {
        for (const outcome of (mkt.outcomes || [])) {
          const selectionKey = `${outcome.name}:${outcome.point ?? ''}`;
          const snapshotKey  = `nba:snap:${gameId}:${mkt.key}:${selectionKey}:${book.key}`;

          // Append a compact snapshot: "<ts>,<price>,<point>"
          const point = outcome.point != null ? outcome.point : '';
          pipe.rPush(snapshotKey, `${now},${outcome.price},${point}`);
          pipe.expire(snapshotKey, 60 * 60 * 24 * 21); // 21 days
        }
      }
    }
  }

  try {
    await pipe.exec();
  } catch (err) {
    console.warn('[nba-logger] snapshot pipeline error:', err.message);
  }
}

// ─── 2. Derive Open / Close from Snapshots ────────────────────────────────────
// Returns { open: {price, point, ts}, close: {price, point, ts} } or null

async function getOpenClose(gameId, marketKey, selectionKey, book = 'draftkings') {
  const redis = await getRedis();
  if (!redis) return null;

  const snapshotKey = `nba:snap:${gameId}:${marketKey}:${selectionKey}:${book}`;
  const commenceTs  = await redis.hGet(`nba:game:${gameId}`, 'commence_time');
  const cutoff      = commenceTs ? new Date(commenceTs).getTime() - 5 * 60 * 1000 : null;

  try {
    const raw = await redis.lRange(snapshotKey, 0, -1);
    if (!raw.length) return null;

    const parsed = raw.map(r => {
      const [ts, price, point] = r.split(',');
      return { ts: parseInt(ts), price: parseInt(price), point: point !== '' ? parseFloat(point) : null };
    });

    const open  = parsed[0];
    const close = cutoff
      ? [...parsed].reverse().find(s => s.ts <= cutoff) || parsed[parsed.length - 1]
      : parsed[parsed.length - 1];

    return { open, close };
  } catch {
    return null;
  }
}

// ─── 3. Log a Model Prediction ────────────────────────────────────────────────
// Call this from your NBA model evaluation code just before games start.
//
// prediction shape:
// {
//   gameId, book, marketType, marketKey, selection,
//   line,           // numeric point (spread/total/prop line)
//   priceAtEval,    // American odds at evaluation time
//   modelProb,      // 0–1
//   modelEdge,      // modelProb − market_no_vig_prob
//   confidenceTier, // 'LOW' | 'MED' | 'HIGH'
// }

async function logPrediction(prediction) {
  const redis = await getRedis();
  const predId = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.createHash('sha256').update(JSON.stringify({ ...prediction, t: Date.now() })).digest('hex').slice(0, 16);

  const record = {
    predId,
    gameId:         prediction.gameId,
    book:           prediction.book           || 'draftkings',
    marketType:     prediction.marketType,     // 'SPREAD'|'TOTAL'|'MONEYLINE'|'PROP'
    marketKey:      prediction.marketKey,      // 'h2h'|'spreads'|'totals'|'player_points'…
    selection:      prediction.selection,      // 'home'|'away'|'over'|'under'|'PlayerName OVER 24.5'
    line:           prediction.line      ?? '',
    priceAtEval:    prediction.priceAtEval,
    modelProb:      prediction.modelProb,
    modelEdge:      prediction.modelEdge,
    confidenceTier: prediction.confidenceTier || 'MED',
    createdAt:      new Date().toISOString(),
    // Filled by resolver:
    closingLine:    '',
    closingPrice:   '',
    isHighMove:     '',   // '1' if |close - open| >= 0.5
    resultOutcome:  '',   // 'WIN'|'LOSE'|'PUSH'
    resultValue:    '',   // numeric P&L (flat 1u)
    clvBeaten:      '',   // '1'|'0'
    resolvedAt:     '',
  };

  if (redis) {
    try {
      await redis.hSet(`nba:pred:${predId}`, record);
      await redis.lPush('nba:predictions:log', predId);
      await redis.sAdd('nba:predictions:pending', predId);
      await redis.expire(`nba:pred:${predId}`, 60 * 60 * 24 * 180);
    } catch (err) {
      console.warn('[nba-logger] prediction write failed:', err.message);
    }
  }

  return predId;
}

// ─── 4. Resolve a Prediction ──────────────────────────────────────────────────
// Called by the nightly results worker (api/nba-resolve.js)
//
// resolution: { closingLine, closingPrice, resultOutcome, resultValue, clvBeaten }

async function resolvePrediction(predId, resolution) {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    await redis.hSet(`nba:pred:${predId}`, {
      closingLine:   resolution.closingLine   ?? '',
      closingPrice:  resolution.closingPrice  ?? '',
      isHighMove:    resolution.isHighMove    ?? '',
      resultOutcome: resolution.resultOutcome,
      resultValue:   resolution.resultValue   ?? '',
      clvBeaten:     resolution.clvBeaten     ?? '',
      resolvedAt:    new Date().toISOString(),
    });
    await redis.sRem('nba:predictions:pending', predId);
    return true;
  } catch {
    return false;
  }
}

// ─── 5. Fetch Predictions ─────────────────────────────────────────────────────

async function fetchPredictions(limit = 500, resolvedOnly = false) {
  const redis = await getRedis();
  if (!redis) return [];
  try {
    const ids = await redis.lRange('nba:predictions:log', 0, limit - 1);
    const rows = await Promise.all(ids.map(id => redis.hGetAll(`nba:pred:${id}`)));
    const parsed = rows
      .filter(r => r && r.predId)
      .map(r => ({
        ...r,
        line:          r.line          !== '' ? parseFloat(r.line)          : null,
        priceAtEval:   r.priceAtEval   !== '' ? parseInt(r.priceAtEval)     : null,
        modelProb:     r.modelProb     !== '' ? parseFloat(r.modelProb)     : null,
        modelEdge:     r.modelEdge     !== '' ? parseFloat(r.modelEdge)     : null,
        closingLine:   r.closingLine   !== '' ? parseFloat(r.closingLine)   : null,
        closingPrice:  r.closingPrice  !== '' ? parseInt(r.closingPrice)    : null,
        isHighMove:    r.isHighMove    === '1',
        clvBeaten:     r.clvBeaten     === '1',
        resultValue:   r.resultValue   !== '' ? parseFloat(r.resultValue)   : null,
      }));
    return resolvedOnly
      ? parsed.filter(r => r.resultOutcome === 'WIN' || r.resultOutcome === 'LOSE' || r.resultOutcome === 'PUSH')
      : parsed;
  } catch {
    return [];
  }
}

async function fetchPendingPredictionIds() {
  const redis = await getRedis();
  if (!redis) return [];
  try { return await redis.sMembers('nba:predictions:pending'); } catch { return []; }
}

module.exports = {
  logOddsSnapshot,
  getOpenClose,
  logPrediction,
  resolvePrediction,
  fetchPredictions,
  fetchPendingPredictionIds,
};
