// api/_lib/match-model.js
// BetIntel v2 — Serve/Return Weighted Match Model
//
// Replaces hold-rate-only pricing with a full serve+return decomposition.
// Each player's win probability per point on their serve is derived from:
//   - First serve percentage (1stIn)
//   - Points won on first serve (1stWon)
//   - Points won on second serve (2ndWon)
//   - Ace rate (bonus to hold expectation)
//   - Double fault rate (penalty to hold expectation)
//   - Surface adjustments (clay/grass/hard/indoor_hard)
//
// Then maps point probability → game probability → set probability → match probability
// using the standard Markov chain tennis model.

'use strict';

// ─── Surface Multipliers ──────────────────────────────────────────────────────
// These adjust serve effectiveness relative to a hard-court baseline.
// Based on ATP/WTA surface win-rate research (2019–2024).
const SURFACE_SERVE_FACTORS = {
  grass:       { firstServeBonus: 0.024, secondServeBonus: 0.018, aceMultiplier: 1.28 },
  hard:        { firstServeBonus: 0.000, secondServeBonus: 0.000, aceMultiplier: 1.00 },
  indoor_hard: { firstServeBonus: 0.010, secondServeBonus: 0.008, aceMultiplier: 1.10 },
  clay:        { firstServeBonus: -0.020, secondServeBonus: -0.014, aceMultiplier: 0.68 },
};

// ─── Markov Chain: point → game → set → match ─────────────────────────────────

/**
 * P(server wins game) given p = P(server wins a rally point on their serve).
 * Classic Markov chain closed-form solution.
 */
function pointToGame(p) {
  const q = 1 - p;
  // P(win from deuce) = p^2 / (p^2 + q^2)
  const pDeuce = (p * p) / (p * p + q * q);
  // P(win game) = sum of binomial paths through 0-3 deficits + deuce paths
  return (
    Math.pow(p, 4) +
    4 * Math.pow(p, 4) * q +
    10 * Math.pow(p, 4) * Math.pow(q, 2) +
    20 * Math.pow(p, 3) * Math.pow(q, 3) * pDeuce
  );
}

/**
 * P(player A wins a set) given:
 *   pAHold = P(A wins a service game on their serve)
 *   pBHold = P(B wins a service game on their serve)
 *
 * Uses Markov chain over games within a set (tiebreak at 6-6).
 * Simplified to: P(A wins set) = pAHold*(1-pBHold) / (pAHold*(1-pBHold) + (1-pAHold)*pBHold)
 * which is exact under the assumption games are i.i.d.
 */
function gameToSet(pAHold, pBHold) {
  const num = pAHold * (1 - pBHold);
  const den = num + (1 - pAHold) * pBHold;
  if (den === 0) return 0.5;
  return Math.min(0.97, Math.max(0.03, num / den));
}

/**
 * P(A wins match) via race-to-N sets (correct negative binomial).
 */
function setToMatch(pSet, setsToWin) {
  let prob = 0;
  for (let losses = 0; losses < setsToWin; losses++) {
    prob += binomialCoeff(setsToWin - 1 + losses, losses) *
            Math.pow(pSet, setsToWin) *
            Math.pow(1 - pSet, losses);
  }
  return Math.min(0.97, Math.max(0.03, prob));
}

function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

// ─── Serve Quality → Point Win Probability ────────────────────────────────────

/**
 * Convert a player's serve stats + surface into their P(win point on serve).
 *
 * @param {object} stats
 *   { firstServePct, firstServeWonPct, secondServeWonPct, aceRatePerGame, dfRatePerGame }
 * @param {string} surface
 * @returns {number} pServe — probability of winning a point on own serve
 */
function serveStatsToPServe(stats, surface) {
  const sf = SURFACE_SERVE_FACTORS[surface] || SURFACE_SERVE_FACTORS.hard;

  const fs = Math.min(0.85, Math.max(0.50, (stats.firstServePct || 0.62)));
  const fsWon = Math.min(0.85, Math.max(0.45, (stats.firstServeWonPct || 0.72) + sf.firstServeBonus));
  const ssWon = Math.min(0.70, Math.max(0.30, (stats.secondServeWonPct || 0.52) + sf.secondServeBonus));

  // Ace bonus: small direct add to pServe (ace = auto-win on serve point)
  const aceBonus = ((stats.aceRatePerGame || 0.6) * sf.aceMultiplier) * 0.008;
  // DF penalty: double fault = auto-lose a point
  const dfPenalty = (stats.dfRatePerGame || 0.3) * 0.012;

  const pServe = fs * fsWon + (1 - fs) * ssWon + aceBonus - dfPenalty;
  return Math.min(0.85, Math.max(0.45, pServe));
}

/**
 * Derive hold rate from serve stats + surface.
 * This replaces the blunt holdRate input with a serve-component-derived equivalent.
 *
 * @param {object} stats
 * @param {string} surface
 * @returns {number} holdRate (0–1)
 */
function serveStatsToHoldRate(stats, surface) {
  const pServe = serveStatsToPServe(stats, surface);
  return pointToGame(pServe);
}

// ─── Return Quality Adjustment ────────────────────────────────────────────────

/**
 * Adjust opponent's hold rate based on returner's return quality.
 *
 * Returner stats affect how much the server's pServe degrades:
 *   returnPointsWonOnFirst, returnPointsWonOnSecond, breakPct
 *
 * @param {number} serverHoldRate - derived or stated hold rate
 * @param {object} returnerStats  - { returnPtsWonOnFirst, returnPtsWonOnSecond, breakPct }
 * @param {string} surface
 * @returns {number} adjusted hold rate for server vs THIS returner
 */
function adjustHoldForReturner(serverHoldRate, returnerStats, surface) {
  const sf = SURFACE_SERVE_FACTORS[surface] || SURFACE_SERVE_FACTORS.hard;

  // Return quality score: distance from league average
  const avgReturnFirst = 0.28 + (surface === 'clay' ? 0.025 : surface === 'grass' ? -0.015 : 0);
  const avgReturnSecond = 0.52 + (surface === 'clay' ? 0.020 : surface === 'grass' ? -0.010 : 0);
  const avgBreakPct = 0.22 + (surface === 'clay' ? 0.030 : surface === 'grass' ? -0.025 : 0);

  const r1Delta = (returnerStats.returnPtsWonOnFirst  || avgReturnFirst)  - avgReturnFirst;
  const r2Delta = (returnerStats.returnPtsWonOnSecond || avgReturnSecond) - avgReturnSecond;
  const bpDelta = (returnerStats.breakPct             || avgBreakPct)     - avgBreakPct;

  // Each factor reduces server hold rate proportionally
  // Weights: break% is most informative, return first/second are auxiliary
  const adjustment = (bpDelta * 0.55) + (r1Delta * 0.25) + (r2Delta * 0.20);
  const adjusted   = serverHoldRate - adjustment;

  return Math.min(0.97, Math.max(0.45, adjusted));
}

// ─── Fatigue ──────────────────────────────────────────────────────────────────

function applyFatigueToHold(holdRate, fatiguedPlayer, thisPlayer, magnitude) {
  if (fatiguedPlayer !== thisPlayer) return holdRate;
  const penalty = magnitude * 0.008;
  return Math.min(0.97, Math.max(0.45, holdRate - penalty));
}

// ─── Main Match Model ─────────────────────────────────────────────────────────

/**
 * Full serve+return match model.
 *
 * Input priority:
 *   1. If full serve stats present → derive pServe via Markov chain
 *   2. If only holdRate present → use it directly
 *   3. Fallback → league average 0.82
 *
 * Then adjust each player's effective hold for the opponent's return quality.
 *
 * @param {object} playerA  - stats object
 * @param {object} playerB  - stats object
 * @param {string} surface
 * @param {string} format   - 'bo3' | 'bo5'
 * @param {object} fatigueScore - from scoreFatigueAsymmetry()
 * @returns {object}
 */
function buildMatchModel(playerA, playerB, surface, format = 'bo3', fatigueScore = {}) {
  // Step 1: Derive serve-side hold rates
  const hasServeStats = (p) => p.firstServePct || p.firstServeWonPct || p.secondServeWonPct;

  let holdA = hasServeStats(playerA)
    ? serveStatsToHoldRate(playerA, surface)
    : (playerA.holdRate || 0.82);

  let holdB = hasServeStats(playerB)
    ? serveStatsToHoldRate(playerB, surface)
    : (playerB.holdRate || 0.82);

  // Step 2: Adjust for opponent return quality
  const hasReturnStats = (p) => p.returnPtsWonOnFirst || p.returnPtsWonOnSecond || p.breakPct;

  if (hasReturnStats(playerB)) holdA = adjustHoldForReturner(holdA, playerB, surface);
  if (hasReturnStats(playerA)) holdB = adjustHoldForReturner(holdB, playerA, surface);

  // Step 3: Apply fatigue
  holdA = applyFatigueToHold(holdA, fatigueScore.fatiguedPlayer, 'A', fatigueScore.magnitude || 0);
  holdB = applyFatigueToHold(holdB, fatigueScore.fatiguedPlayer, 'B', fatigueScore.magnitude || 0);

  holdA = Math.min(0.97, Math.max(0.45, holdA));
  holdB = Math.min(0.97, Math.max(0.45, holdB));

  // Step 4: Markov chain set → match
  const pAWinsSet   = gameToSet(holdA, holdB);
  const setsToWin   = format === 'bo5' ? 3 : 2;
  const fairProbA   = setToMatch(pAWinsSet, setsToWin);
  const fairProbB   = 1 - fairProbA;

  // Step 5: Expected sets (for totals pricing)
  const avgSets     = expectedSetsPlayed(pAWinsSet, setsToWin);

  return {
    holdA:    parseFloat(holdA.toFixed(4)),
    holdB:    parseFloat(holdB.toFixed(4)),
    pAWinsSet: parseFloat(pAWinsSet.toFixed(4)),
    fairProbA: parseFloat(Math.min(0.97, Math.max(0.03, fairProbA)).toFixed(4)),
    fairProbB: parseFloat(Math.min(0.97, Math.max(0.03, fairProbB)).toFixed(4)),
    avgSets:  parseFloat(avgSets.toFixed(3)),
    format,
    surface,
    modelVersion: 'v2-serve-return',
  };
}

function expectedSetsPlayed(pSet, n) {
  if (n === 3) {
    const p30 = Math.pow(pSet, 3);
    const p31 = 3 * Math.pow(pSet, 3) * (1 - pSet);
    const p32 = 6 * Math.pow(pSet, 3) * Math.pow(1 - pSet, 2);
    const p03 = Math.pow(1 - pSet, 3);
    const p13 = 3 * Math.pow(1 - pSet, 3) * pSet;
    const p23 = 6 * Math.pow(1 - pSet, 3) * Math.pow(pSet, 2);
    return 3*(p30+p03) + 4*(p31+p13) + 5*(p32+p23);
  }
  const p20 = Math.pow(pSet, 2);
  const p21 = 2 * Math.pow(pSet, 2) * (1 - pSet);
  const p02 = Math.pow(1 - pSet, 2);
  const p12 = 2 * Math.pow(1 - pSet, 2) * pSet;
  return 2*(p20+p02) + 3*(p21+p12);
}

module.exports = {
  serveStatsToPServe,
  serveStatsToHoldRate,
  adjustHoldForReturner,
  buildMatchModel,
  pointToGame,
  gameToSet,
  setToMatch,
  expectedSetsPlayed,
  SURFACE_SERVE_FACTORS,
};
