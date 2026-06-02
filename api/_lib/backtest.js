// api/_lib/backtest.js
// BetIntel v2 — Backtest & Calibration Scaffolding
//
// Ingests historical records of the form:
//   { matchId, market, side, line, bookOdds, modelFairProb, noVigProb,
//     closeOdds, outcome: 'win'|'loss', confidence: 'HIGH'|'MEDIUM'|'LOW' }
//
// Produces:
//   - Hit rate by confidence tier
//   - Brier score (calibration quality)
//   - Closing Line Value (CLV) — the primary sharpness signal
//   - Kelly growth simulation
//   - Edge vs no-vig baseline distribution
//
// This module is a scaffolding: wire it to your historical data store
// and call evaluate() on any set of resolved picks.

'use strict';

const { noVig, americanToImplied } = require('./no-vig');

/**
 * Closing Line Value.
 * CLV = model fair prob - no-vig close probability
 * Positive CLV = you priced it better than the market at close.
 * Industry threshold: +2pt average CLV = genuinely sharp model.
 *
 * @param {number} modelFairProb
 * @param {number} closeOdds   - American odds at close
 * @param {number} closeOddsOpp - American odds for opposite side at close
 * @returns {number} CLV in percentage points
 */
function computeCLV(modelFairProb, closeOdds, closeOddsOpp) {
  try {
    const { fairA } = noVig(closeOdds, closeOddsOpp);
    return parseFloat(((modelFairProb - fairA) * 100).toFixed(2));
  } catch {
    return null;
  }
}

/**
 * Brier Score for a set of picks.
 * Lower = better calibration. Perfect = 0.0. Coin flip = 0.25.
 *
 * @param {Array} picks - each: { modelFairProb, outcome: 'win'|'loss' }
 * @returns {number}
 */
function brierScore(picks) {
  if (!picks.length) return null;
  const sum = picks.reduce((acc, p) => {
    const actual = p.outcome === 'win' ? 1 : 0;
    return acc + Math.pow(p.modelFairProb - actual, 2);
  }, 0);
  return parseFloat((sum / picks.length).toFixed(4));
}

/**
 * Hit rate analysis by confidence tier.
 * Returns { HIGH: { bets, hits, hitRate }, MEDIUM: {...}, LOW: {...}, ALL: {...} }
 *
 * @param {Array} picks
 * @returns {object}
 */
function hitRateByTier(picks) {
  const tiers = { HIGH: [], MEDIUM: [], LOW: [], ALL: picks };
  picks.forEach(p => { if (tiers[p.confidence]) tiers[p.confidence].push(p); });

  const summarize = (arr) => {
    if (!arr.length) return { bets: 0, hits: 0, hitRate: null, expectedHitRate: null };
    const hits = arr.filter(p => p.outcome === 'win').length;
    const avgModelProb = arr.reduce((s, p) => s + p.modelFairProb, 0) / arr.length;
    return {
      bets: arr.length,
      hits,
      hitRate: parseFloat((hits / arr.length).toFixed(4)),
      expectedHitRate: parseFloat(avgModelProb.toFixed(4)),
      calibrationDelta: parseFloat(((hits/arr.length) - avgModelProb).toFixed(4)),
    };
  };

  return {
    HIGH:   summarize(tiers.HIGH),
    MEDIUM: summarize(tiers.MEDIUM),
    LOW:    summarize(tiers.LOW),
    ALL:    summarize(tiers.ALL),
  };
}

/**
 * CLV summary across all picks.
 * @param {Array} picks - each: { modelFairProb, closeOdds, closeOddsOpp }
 * @returns {object}
 */
function clvSummary(picks) {
  const withCLV = picks
    .map(p => ({ ...p, clv: computeCLV(p.modelFairProb, p.closeOdds, p.closeOddsOpp) }))
    .filter(p => p.clv !== null);

  if (!withCLV.length) return { count: 0, avgCLV: null, pctPositive: null };

  const avgCLV = withCLV.reduce((s, p) => s + p.clv, 0) / withCLV.length;
  const pctPositive = withCLV.filter(p => p.clv > 0).length / withCLV.length;

  return {
    count: withCLV.length,
    avgCLV: parseFloat(avgCLV.toFixed(3)),
    pctPositive: parseFloat((pctPositive * 100).toFixed(1)),
    interpretation:
      avgCLV >= 2   ? 'SHARP — model consistently beats closing line (+2pt threshold met)' :
      avgCLV >= 0.5 ? 'MARGINAL — weak positive CLV. Continue tracking; not yet proven sharp.' :
      avgCLV >= 0   ? 'FLAT — model is at market efficiency. No edge confirmed.' :
                      'NEGATIVE CLV — model is pricing WORSE than the market. Do not use for real bets.',
  };
}

/**
 * Edge distribution: how often do HIGH confidence picks actually have edge?
 * @param {Array} picks
 * @returns {object}
 */
function edgeDistribution(picks) {
  const bins = { 'lt0': 0, '0to2': 0, '2to4': 0, '4to6': 0, 'gt6': 0 };
  picks.forEach(p => {
    const e = p.edgePts || 0;
    if (e < 0) bins['lt0']++;
    else if (e < 2) bins['0to2']++;
    else if (e < 4) bins['2to4']++;
    else if (e < 6) bins['4to6']++;
    else bins['gt6']++;
  });
  return bins;
}

/**
 * Master evaluate() function.
 * Wire this to a historical picks array once resolved picks exist.
 *
 * @param {Array} picks
 * @returns {object} full calibration report
 */
function evaluate(picks) {
  if (!Array.isArray(picks) || !picks.length) {
    return { error: 'No picks provided. Pass an array of resolved pick records.' };
  }

  const resolved = picks.filter(p => p.outcome === 'win' || p.outcome === 'loss');
  const unresolved = picks.length - resolved.length;

  return {
    meta: {
      totalPicks: picks.length,
      resolvedPicks: resolved.length,
      unresolvedPicks: unresolved,
      evaluatedAt: new Date().toISOString(),
    },
    hitRates:       hitRateByTier(resolved),
    brierScore:     brierScore(resolved),
    clv:            clvSummary(resolved),
    edgeDistrib:    edgeDistribution(resolved),
    interpretation: buildInterpretation(resolved),
  };
}

function buildInterpretation(picks) {
  if (picks.length < 30) {
    return `INSUFFICIENT SAMPLE: ${picks.length} resolved picks. Need 30+ for meaningful calibration. Keep logging.`;
  }
  const clv = clvSummary(picks);
  const tiers = hitRateByTier(picks);
  const lines = [];

  lines.push(`CLV: ${clv.avgCLV}pt avg (${clv.pctPositive}% positive) — ${clv.interpretation}`);
  if (tiers.HIGH.bets > 0) lines.push(`HIGH confidence: ${tiers.HIGH.hits}/${tiers.HIGH.bets} (${(tiers.HIGH.hitRate*100).toFixed(1)}% actual vs ${(tiers.HIGH.expectedHitRate*100).toFixed(1)}% expected, delta ${tiers.HIGH.calibrationDelta > 0 ? '+':''}${(tiers.HIGH.calibrationDelta*100).toFixed(1)}%)`);
  if (tiers.MEDIUM.bets > 0) lines.push(`MEDIUM confidence: ${tiers.MEDIUM.hits}/${tiers.MEDIUM.bets} (${(tiers.MEDIUM.hitRate*100).toFixed(1)}% actual vs ${(tiers.MEDIUM.expectedHitRate*100).toFixed(1)}% expected)`);

  if (clv.avgCLV < 0) lines.push('ACTION: Model is pricing against the market. Revisit serve/return weights and surface factors before live use.');
  else if (tiers.HIGH.calibrationDelta < -0.05) lines.push('ACTION: HIGH confidence picks are underperforming expected hit rate by 5%+. Recalibrate confidence tier thresholds.');
  else lines.push('Model is tracking as expected. Continue logging for 100+ picks before adjusting weights.');

  return lines.join(' | ');
}

module.exports = { computeCLV, brierScore, hitRateByTier, clvSummary, edgeDistribution, evaluate };
