// api/_lib/picks-store.js
// BetIntel v2 — Picks Logger / Store
//
// Persists every evaluated prop to Redis as a time-series log.
// Each record captures:
//   matchId, market, side, line, bookOdds, bookOddsOpp,
//   modelFairProb, noVigProb, edgePts, confidence, verdict,
//   closeOdds (set later when market closes), outcome (set after match)
//
// These records are the input to backtest.evaluate() for CLV and calibration.
//
// Storage:
//   Redis LIST  key: betintel:picks:log       (all picks, newest first)
//   Redis HASH  key: betintel:picks:{pickId}  (individual record for updates)
//   Redis SET   key: betintel:picks:pending   (pickIds awaiting outcome)

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

/**
 * Log a batch of evaluated props from a single tennis-picks request.
 *
 * @param {object} meta       - { matchId, playerA, playerB, surface, format, tournament, round, generatedAt }
 * @param {Array}  picks      - evaluated prop results from tennis-picks handler
 * @param {object} matchModel - match model snapshot
 * @returns {Promise<string[]>} array of pickIds logged
 */
async function logPicks(meta, picks, matchModel) {
  const redis = await getRedis();
  const pickIds = [];

  for (const pick of picks) {
    if (!pick.verdict || pick.verdict.startsWith('NO BET')) continue; // only log BET and MARGINAL

    const pickId = crypto.randomUUID ? crypto.randomUUID()
      : crypto.createHash('sha256').update(JSON.stringify({ meta, pick, t: Date.now() })).digest('hex').slice(0, 16);

    const record = {
      pickId,
      // Match context
      matchId:      meta.matchId || `${meta.playerA}-vs-${meta.playerB}-${meta.generatedAt?.slice(0,10)}`,
      playerA:      meta.playerA,
      playerB:      meta.playerB,
      surface:      meta.surface,
      format:       meta.format,
      tournament:   meta.tournament || '',
      round:        meta.round || '',
      generatedAt:  meta.generatedAt || new Date().toISOString(),
      // Prop spec
      market:       pick.market,
      side:         pick.side,
      line:         pick.line || null,
      bookOdds:     pick.bookOdds,
      // Pricing
      impliedProb:  pick.impliedProb,
      noVigProb:    pick.noVigProb,
      vigPct:       pick.vigPct,
      modelFairProb: parseFloat((pick.fairProb || '0').replace('%','')) / 100,
      edgePts:      parseFloat((pick.edgePts || '0').replace('+','')),
      confidence:   pick.confidence,
      verdict:      pick.verdict,
      // Match model snapshot
      modelHoldA:   matchModel?.holdA,
      modelHoldB:   matchModel?.holdB,
      modelPAWinsSet: matchModel?.pAWinsSet,
      modelVersion: matchModel?.modelVersion || 'v2',
      // To be filled in later
      closeOdds:    null,
      closeOddsOpp: null,
      outcome:      null,  // 'win' | 'loss'
      resolvedAt:   null,
    };

    if (redis) {
      try {
        await redis.hSet(`betintel:picks:${pickId}`, record);
        await redis.lPush('betintel:picks:log', pickId);
        await redis.sAdd('betintel:picks:pending', pickId);
        // Expire individual records after 180 days
        await redis.expire(`betintel:picks:${pickId}`, 60 * 60 * 24 * 180);
      } catch (err) {
        console.warn('[picks-store] Redis write failed:', err.message);
      }
    }

    pickIds.push(pickId);
  }

  return pickIds;
}

/**
 * Resolve a pick: set closeOdds, closeOddsOpp, and outcome.
 * Called by POST /api/picks-resolve or a cron job after match completion.
 *
 * @param {string} pickId
 * @param {object} resolution - { closeOdds, closeOddsOpp, outcome: 'win'|'loss' }
 * @returns {Promise<bool>}
 */
async function resolvePick(pickId, resolution) {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    await redis.hSet(`betintel:picks:${pickId}`, {
      closeOdds:    resolution.closeOdds    ?? null,
      closeOddsOpp: resolution.closeOddsOpp ?? null,
      outcome:      resolution.outcome,
      resolvedAt:   new Date().toISOString(),
    });
    await redis.sRem('betintel:picks:pending', pickId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch all picks (or a slice) from the log for backtest input.
 *
 * @param {number} limit  - max records to return (default 500)
 * @param {bool}   resolvedOnly - if true, skip picks without outcome
 * @returns {Promise<Array>}
 */
async function fetchPicks(limit = 500, resolvedOnly = false) {
  const redis = await getRedis();
  if (!redis) return [];
  try {
    const pickIds = await redis.lRange('betintel:picks:log', 0, limit - 1);
    const records = await Promise.all(
      pickIds.map(id => redis.hGetAll(`betintel:picks:${id}`))
    );
    const parsed = records
      .filter(r => r && r.pickId)
      .map(r => ({
        ...r,
        modelFairProb: parseFloat(r.modelFairProb) || null,
        edgePts:       parseFloat(r.edgePts)       || null,
        closeOdds:     r.closeOdds ? parseInt(r.closeOdds) : null,
        closeOddsOpp:  r.closeOddsOpp ? parseInt(r.closeOddsOpp) : null,
      }));
    return resolvedOnly ? parsed.filter(r => r.outcome === 'win' || r.outcome === 'loss') : parsed;
  } catch {
    return [];
  }
}

/**
 * Fetch all pending (unresolved) pick IDs.
 * @returns {Promise<string[]>}
 */
async function fetchPendingPickIds() {
  const redis = await getRedis();
  if (!redis) return [];
  try {
    return await redis.sMembers('betintel:picks:pending');
  } catch {
    return [];
  }
}

module.exports = { logPicks, resolvePick, fetchPicks, fetchPendingPickIds };
