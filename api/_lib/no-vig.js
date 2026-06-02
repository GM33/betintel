// api/_lib/no-vig.js
// BetIntel v2 — No-Vig (Fair Market) Pricing Layer
//
// Removes bookmaker margin from two-sided markets so edge is measured
// against the fair market baseline, not a margin-inflated implied prob.
//
// Supports:
//   - Basic 2-outcome removal (Shin, additive, multiplicative)
//   - Correlated two-line totals (over/under)
//   - Market-wide vig audit

'use strict';

/**
 * American odds → raw implied probability (vig-inclusive).
 */
function americanToImplied(odds) {
  if (typeof odds !== 'number') throw new Error('odds must be a number');
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * Remove vig from a two-outcome market using additive normalization.
 * This is the most common and interpretable method for ML and two-sided totals.
 *
 * @param {number} oddsA - American odds for side A
 * @param {number} oddsB - American odds for side B
 * @returns {object} { fairA, fairB, vigPct, totalOverround }
 */
function removeVig2Way(oddsA, oddsB) {
  const rawA = americanToImplied(oddsA);
  const rawB = americanToImplied(oddsB);
  const overround = rawA + rawB;
  const fairA = rawA / overround;
  const fairB = rawB / overround;
  const vigPct = parseFloat(((overround - 1) * 100).toFixed(3));

  return {
    fairA: parseFloat(fairA.toFixed(5)),
    fairB: parseFloat(fairB.toFixed(5)),
    vigPct,
    totalOverround: parseFloat(overround.toFixed(5)),
    rawA: parseFloat(rawA.toFixed(5)),
    rawB: parseFloat(rawB.toFixed(5)),
  };
}

/**
 * Shin method vig removal — more accurate for favorites in skewed markets.
 * Solves for z (fraction of bets from informed bettors) iteratively.
 *
 * @param {number} oddsA
 * @param {number} oddsB
 * @returns {object} { fairA, fairB, vigPct, shinZ }
 */
function removeVigShin(oddsA, oddsB) {
  const rawA = americanToImplied(oddsA);
  const rawB = americanToImplied(oddsB);
  const overround = rawA + rawB;

  // Iterative Shin: solve for z that satisfies sum(p_i) = 1
  let z = 0.02;
  for (let iter = 0; iter < 100; iter++) {
    const pA = Math.sqrt(z * z + 4 * (1 - z) * (rawA / overround) * z) / (2 * (1 - z)) - z / (2 * (1 - z));
    const pB = Math.sqrt(z * z + 4 * (1 - z) * (rawB / overround) * z) / (2 * (1 - z)) - z / (2 * (1 - z));
    const sum = pA + pB;
    if (Math.abs(sum - 1) < 0.0001) break;
    z += (sum - 1) * 0.01;
    z = Math.min(0.15, Math.max(0, z));
  }

  const shinA = Math.sqrt(z * z + 4 * (1 - z) * (rawA / overround) * z) / (2 * (1 - z)) - z / (2 * (1 - z));
  const shinB = 1 - shinA;

  return {
    fairA: parseFloat(Math.min(0.97, Math.max(0.03, shinA)).toFixed(5)),
    fairB: parseFloat(Math.min(0.97, Math.max(0.03, shinB)).toFixed(5)),
    vigPct: parseFloat(((overround - 1) * 100).toFixed(3)),
    shinZ: parseFloat(z.toFixed(5)),
    method: 'shin',
  };
}

/**
 * Primary no-vig entry point.
 * Chooses Shin for heavily skewed markets (implied favorite > 70%),
 * additive for balanced markets.
 *
 * @param {number} oddsA
 * @param {number} oddsB
 * @param {'auto'|'additive'|'shin'} method
 * @returns {object}
 */
function noVig(oddsA, oddsB, method = 'auto') {
  const rawA = americanToImplied(oddsA);
  const useMethod = method === 'auto' ? (rawA > 0.65 || rawA < 0.35 ? 'shin' : 'additive') : method;

  if (useMethod === 'shin') {
    return { ...removeVigShin(oddsA, oddsB), method: 'shin' };
  }
  return { ...removeVig2Way(oddsA, oddsB), method: 'additive' };
}

/**
 * Compute the edge of a model probability versus the no-vig market fair probability.
 * This is the only valid edge measurement. Using raw implied prob inflates edge estimates.
 *
 * @param {number} modelProb  - Your model's fair probability (0–1)
 * @param {number} noVigProb  - Market no-vig probability for same side (0–1)
 * @returns {number} edge in percentage points (positive = model has edge)
 */
function edgeVsNoVig(modelProb, noVigProb) {
  return parseFloat(((modelProb - noVigProb) * 100).toFixed(2));
}

/**
 * Audit a market: shows vig, no-vig probs, and Kelly fraction.
 * Useful for the backtest and calibration pipeline.
 *
 * @param {number} oddsA
 * @param {number} oddsB
 * @param {number} modelProbA - model fair prob for side A
 * @returns {object}
 */
function auditMarket(oddsA, oddsB, modelProbA) {
  const nv = noVig(oddsA, oddsB);
  const edgePtsA = edgeVsNoVig(modelProbA, nv.fairA);
  const edgePtsB = edgeVsNoVig(1 - modelProbA, nv.fairB);
  const rawA = americanToImplied(oddsA);

  // Full Kelly fraction for side A
  const kellyA = edgePtsA > 0
    ? parseFloat((edgePtsA / 100 / (rawA > 0 ? rawA : 1 - rawA)).toFixed(4))
    : 0;

  return {
    oddsA, oddsB,
    rawImpliedA: parseFloat(rawA.toFixed(5)),
    rawImpliedB: parseFloat(americanToImplied(oddsB).toFixed(5)),
    noVigA: nv.fairA,
    noVigB: nv.fairB,
    vigPct: nv.vigPct,
    method: nv.method,
    modelProbA: parseFloat(modelProbA.toFixed(5)),
    edgeVsRawA: parseFloat(((modelProbA - rawA) * 100).toFixed(2)),
    edgeVsNoVigA: edgePtsA,
    edgeVsNoVigB: edgePtsB,
    kellyFractionA: kellyA,
    note: edgePtsA >= 3
      ? `BET side A — ${edgePtsA}pt edge vs no-vig baseline`
      : edgePtsA >= 1.5
      ? `MARGINAL side A — ${edgePtsA}pt edge, below 3pt threshold`
      : `NO BET — insufficient edge after vig removal`,
  };
}

module.exports = { americanToImplied, removeVig2Way, removeVigShin, noVig, edgeVsNoVig, auditMarket };
