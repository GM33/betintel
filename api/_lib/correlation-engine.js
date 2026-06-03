// api/_lib/correlation-engine.js
// Pearson r calculator + bivariate-normal Monte Carlo joint-probability engine.
// Used by api/parlay-edge.js
//
// Exports:
//   pearsonR(xs, ys)                              → number
//   simulateJointProb(statsA, statsB, lineA, lineB, n) → { pA, pB, pJoint, pIndep, edgePct, r }
//   buildTeamCorrelationMatrix(roster, stat)       → { players[], matrix[][], flaggedPairs[] }
//   computeUsageDisplacement(r, injuryFlag, recencyWeight) → number

'use strict';

// ── Pearson r ──────────────────────────────────────────────────────────────────
function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

// ── Box-Muller normal sample ───────────────────────────────────────────────────
function randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ── Cholesky 2x2 for bivariate normal ─────────────────────────────────────────
// cov matrix: [[sigA^2, rho*sigA*sigB],[rho*sigA*sigB, sigB^2]]
function bivariateSample(muA, sigA, muB, sigB, rho) {
  const z1 = randNormal();
  const z2 = randNormal();
  const a  = muA + sigA * z1;
  const b  = muB + sigB * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);
  return [a, b];
}

// ── Monte Carlo joint probability ─────────────────────────────────────────────
/**
 * @param {number[]} statsA   - historical values for prop A
 * @param {number[]} statsB   - historical values for prop B
 * @param {number}   lineA    - over/under line for prop A
 * @param {number}   lineB    - over/under line for prop B
 * @param {number}   [n=40000]- simulation iterations
 * @param {'over'|'under'} [dirA='over']
 * @param {'over'|'under'} [dirB='over']
 * @returns {{ pA, pB, pJoint, pIndep, edgePct, edgeUnit, r, mu: { a, b }, sigma: { a, b } }}
 */
function simulateJointProb(statsA, statsB, lineA, lineB, n = 40000, dirA = 'over', dirB = 'over') {
  if (!statsA.length || !statsB.length) throw new Error('empty stats arrays');

  const muA  = statsA.reduce((a, b) => a + b, 0) / statsA.length;
  const muB  = statsB.reduce((a, b) => a + b, 0) / statsB.length;
  const sigA = Math.sqrt(statsA.reduce((s, x) => s + (x - muA) ** 2, 0) / statsA.length) || 0.01;
  const sigB = Math.sqrt(statsB.reduce((s, x) => s + (x - muB) ** 2, 0) / statsB.length) || 0.01;
  const r    = pearsonR(statsA, statsB);
  const rho  = Math.max(-0.9999, Math.min(0.9999, r)); // clamp to valid Cholesky range

  const hitA = (v) => dirA === 'over' ? v > lineA : v < lineA;
  const hitB = (v) => dirB === 'over' ? v > lineB : v < lineB;

  let cntA = 0, cntB = 0, cntJoint = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = bivariateSample(muA, sigA, muB, sigB, rho);
    const ha = hitA(a);
    const hb = hitB(b);
    if (ha) cntA++;
    if (hb) cntB++;
    if (ha && hb) cntJoint++;
  }

  const pA     = cntA     / n;
  const pB     = cntB     / n;
  const pJoint = cntJoint / n;
  const pIndep = pA * pB;
  const edgePct  = pIndep > 0 ? ((pJoint - pIndep) / pIndep) * 100 : 0;
  // edge in implied probability points (e.g. +0.05 means parlay hits 5pp more often)
  const edgeUnit = pJoint - pIndep;

  return {
    r:       +r.toFixed(4),
    pA:      +pA.toFixed(4),
    pB:      +pB.toFixed(4),
    pJoint:  +pJoint.toFixed(4),
    pIndep:  +pIndep.toFixed(4),
    edgePct: +edgePct.toFixed(2),
    edgeUnit:+edgeUnit.toFixed(4),
    mu:      { a: +muA.toFixed(2), b: +muB.toFixed(2) },
    sigma:   { a: +sigA.toFixed(2), b: +sigB.toFixed(2) },
  };
}

// ── Full team correlation matrix ───────────────────────────────────────────────
/**
 * @param {Object} roster  - { playerName: { reb: number[], ast: number[] }, ... }
 * @param {'reb'|'ast'} stat
 * @param {number} [threshold=-0.3]  - flag pairs below this r value
 * @returns {{ players: string[], matrix: number[][], flaggedPairs: Array }}
 */
function buildTeamCorrelationMatrix(roster, stat, threshold = -0.3) {
  const players = Object.keys(roster);
  const n = players.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const flaggedPairs = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = i === j ? 1 : pearsonR(roster[players[i]][stat], roster[players[j]][stat]);
      matrix[i][j] = +r.toFixed(4);
      if (i < j && r < threshold) {
        flaggedPairs.push({
          player1: players[i],
          player2: players[j],
          stat,
          r: +r.toFixed(4),
          suggestion: `OVER ${players[i]} ${stat} + UNDER ${players[j]} ${stat}`,
        });
      }
    }
  }

  flaggedPairs.sort((a, b) => a.r - b.r);
  return { players, matrix, flaggedPairs };
}

// ── Usage displacement score ───────────────────────────────────────────────────
/**
 * Combines |r|, recency weight (0-1), and injury penalty into a single
 * 0-1 exploitability score for parlay ranking.
 * @param {number} r              - Pearson r (negative)
 * @param {boolean} injuryFlag    - whether rotation/injury status shifts production
 * @param {number} [recencyWeight=1] - 0-1, higher = more recent games dominate
 * @returns {number}
 */
function computeUsageDisplacement(r, injuryFlag = false, recencyWeight = 1.0) {
  const base  = Math.abs(r) * recencyWeight;
  const bonus = injuryFlag ? 0.05 : 0;  // injury flag lifts score (more acute displacement)
  return +Math.min(1, base + bonus).toFixed(4);
}

module.exports = { pearsonR, simulateJointProb, buildTeamCorrelationMatrix, computeUsageDisplacement };
