// api/_lib/prop-models.js
// BetIntel v2 — Prop-Native Pricing Models
//
// Dedicated fair-probability estimators for:
//   total_games, total_sets, set_spread, ml,
//   player_aces, player_double_faults, total_breaks, player_games_won
//
// Each model takes the matchModel output + prop spec and returns:
//   { fairProb, reasoning[], correlations[], confidence }

'use strict';

const { expectedSetsPlayed, SURFACE_SERVE_FACTORS } = require('./match-model');

// ─── Normal CDF ───────────────────────────────────────────────────────────────
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p = 1 - pdf * poly;
  return z >= 0 ? p : 1 - p;
}

function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

// ─── Total Games ──────────────────────────────────────────────────────────────

/**
 * Fair probability for total games over/under.
 * Uses surface game factor × expected sets derived from match model,
 * with hold-adjusted game depth and a normal approximation for distribution.
 */
function totalGamesFairProb(prop, matchModel, playerA, playerB) {
  const sf = SURFACE_SERVE_FACTORS[matchModel.surface] || SURFACE_SERVE_FACTORS.hard;
  const surfaceGameFactor = matchModel.surface === 'clay' ? 10.2
    : matchModel.surface === 'grass' ? 9.4 : 9.8;

  const avgHold = (matchModel.holdA + matchModel.holdB) / 2;
  const holdGameBonus = (avgHold - 0.82) * 40;
  const expectedGames = parseFloat((surfaceGameFactor * matchModel.avgSets + holdGameBonus).toFixed(1));

  const sd = matchModel.format === 'bo5' ? 3.5 : 2.5;
  const z = (prop.line - expectedGames) / sd;
  const pUnder = normalCDF(z);
  const fairProb = prop.side === 'over' ? 1 - pUnder : pUnder;

  const reasoning = [
    `Expected games: ~${expectedGames} (surface: ${matchModel.surface}, expected sets: ${matchModel.avgSets.toFixed(2)}, avg hold: ${(avgHold*100).toFixed(1)}%)`,
    `Line: ${prop.line} — ${prop.side === 'over' ? 'over' : 'under'} at z=${z.toFixed(2)}`,
  ];
  const correlations = [
    { tag: 'SURFACE', note: `${matchModel.surface} surface: ace multiplier ${sf.aceMultiplier}×, serve bonus ${sf.firstServeBonus > 0 ? '+' : ''}${(sf.firstServeBonus*100).toFixed(1)}%.` },
  ];
  if (avgHold >= 0.84) correlations.push({ tag: 'UNDERRATED', note: 'Both players hold at 84%+ — sets go deeper, pushing game totals above hard-court baselines. Market often underweights this on clay.' });
  if (avgHold <= 0.78) correlations.push({ tag: 'OVERRATED', note: 'Low combined hold rate — frequent breaks shorten sets. Under side may be underpriced.' });

  const n = Math.min(playerA.surfaceMatches || 0, playerB.surfaceMatches || 0);
  const confidence = n >= 25 ? 'HIGH' : n >= 12 ? 'MEDIUM' : 'LOW';

  return { fairProb: parseFloat(fairProb.toFixed(4)), reasoning, correlations, confidence, expectedGames };
}

// ─── Total Sets ───────────────────────────────────────────────────────────────

/**
 * Fair probability for total sets over/under.
 * Derives exact distribution from pAWinsSet for standard lines (2.5 BO3, 3.5/4.5 BO5).
 */
function totalSetsFairProb(prop, matchModel) {
  const p = matchModel.pAWinsSet;
  const q = 1 - p;
  let pOver;

  if (matchModel.format === 'bo5') {
    // BO5 set distribution: P(3), P(4), P(5)
    const p3 = Math.pow(p,3) + Math.pow(q,3);
    const p4 = 3*Math.pow(p,3)*q + 3*Math.pow(q,3)*p;
    const p5 = 6*Math.pow(p,3)*Math.pow(q,2) + 6*Math.pow(q,3)*Math.pow(p,2);
    if (prop.line === 3.5) pOver = p4 + p5;
    else if (prop.line === 4.5) pOver = p5;
    else pOver = matchModel.avgSets > prop.line ? 0.55 : 0.45;
  } else {
    // BO3 set distribution: P(2), P(3)
    const p2 = Math.pow(p,2) + Math.pow(q,2);
    const p3 = 2*Math.pow(p,2)*q + 2*Math.pow(q,2)*p;
    if (prop.line === 2.5) pOver = p3;
    else pOver = matchModel.avgSets > prop.line ? 0.55 : 0.45;
  }

  const fairProb = prop.side === 'over' ? pOver : 1 - pOver;
  const competitiveness = (1 - Math.abs(p - 0.5) * 2).toFixed(2);

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `Set win probability: ${(p*100).toFixed(1)}% (competitiveness score: ${competitiveness})`,
      `Expected sets: ${matchModel.avgSets.toFixed(2)} — line is ${prop.line}`,
    ],
    correlations: [
      { tag: 'STRUCTURAL', note: 'Set distribution derived directly from Markov-chain set win probability — not approximated.' },
    ],
    confidence: 'MEDIUM',
  };
}

// ─── Set Spread ───────────────────────────────────────────────────────────────

/**
 * Fair probability for set spread (underdog +1.5, favorite -1.5).
 * Uses exact sweep probability from pAWinsSet (no magic multipliers).
 */
function setSpreadFairProb(prop, matchModel) {
  const p = matchModel.pAWinsSet;
  const pFavSweep = matchModel.format === 'bo5' ? Math.pow(p, 3) : Math.pow(p, 2);
  const pDogSweep = matchModel.format === 'bo5' ? Math.pow(1-p, 3) : Math.pow(1-p, 2);

  // Underdog covers +1.5 = favorite does NOT sweep
  const pDogCovers = 1 - pFavSweep;
  // Favorite covers -1.5 = wins without dropping a set (sweep)
  const pFavCovers = pFavSweep;

  const fairProb = prop.side === 'underdog_plus' ? pDogCovers : pFavCovers;

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `Sweep probability (set win prob ${(p*100).toFixed(1)}%): ${(pFavSweep*100).toFixed(1)}% — no hidden multipliers.`,
      `Underdog covers +1.5: ${(pDogCovers*100).toFixed(1)}%.`,
    ],
    correlations: [
      { tag: 'UNDERRATED', note: 'High hold rates on clay reduce sweep probability. Market tends to overprice dominant favorites on set spread in longer tournaments.' },
    ],
    confidence: 'MEDIUM',
  };
}

// ─── Player Aces ──────────────────────────────────────────────────────────────

/**
 * Fair probability for player aces over/under.
 * Model: expected aces = aceRatePerGame × expectedGames on serve × aceMultiplier
 * Uses normal approximation with surface-adjusted SD.
 */
function playerAcesFairProb(prop, matchModel, player, playerLabel) {
  const sf = SURFACE_SERVE_FACTORS[matchModel.surface] || SURFACE_SERVE_FACTORS.hard;
  const acesPerGame = (player.aceRatePerGame || 0.55) * sf.aceMultiplier;
  const expectedServingGames = (matchModel.avgSets * 6) / 2; // ~half of service games
  const expectedAces = parseFloat((acesPerGame * expectedServingGames).toFixed(1));
  const sd = Math.max(1.5, expectedAces * 0.35); // ~35% CV
  const z = (prop.line - expectedAces) / sd;
  const pUnder = normalCDF(z);
  const fairProb = prop.side === 'over' ? 1 - pUnder : pUnder;

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `${playerLabel} ace rate: ${acesPerGame.toFixed(2)}/game (surface-adjusted). Expected serving games: ~${expectedServingGames.toFixed(1)}.`,
      `Expected aces: ~${expectedAces} — line ${prop.line}, z=${z.toFixed(2)}.`,
    ],
    correlations: [
      { tag: 'SURFACE', note: `${matchModel.surface} ace multiplier: ${sf.aceMultiplier}×. Grass heavily inflates ace totals; clay deflates sharply.` },
    ],
    confidence: (player.surfaceMatches || 0) >= 15 ? 'MEDIUM' : 'LOW',
  };
}

// ─── Player Double Faults ─────────────────────────────────────────────────────

/**
 * Fair probability for player double faults over/under.
 * Surface has minimal effect on DF rate — mainly a player-specific stat.
 */
function playerDfFairProb(prop, matchModel, player, playerLabel) {
  const dfPerGame = player.dfRatePerGame || 0.28;
  const expectedServingGames = (matchModel.avgSets * 6) / 2;
  const expectedDFs = parseFloat((dfPerGame * expectedServingGames).toFixed(1));
  const sd = Math.max(1.0, expectedDFs * 0.40); // DFs have high variance
  const z = (prop.line - expectedDFs) / sd;
  const pUnder = normalCDF(z);
  const fairProb = prop.side === 'over' ? 1 - pUnder : pUnder;

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `${playerLabel} DF rate: ${dfPerGame.toFixed(2)}/game. Expected serving games: ~${expectedServingGames.toFixed(1)}.`,
      `Expected DFs: ~${expectedDFs} — line ${prop.line}, z=${z.toFixed(2)}.`,
    ],
    correlations: [
      { tag: 'HIGH_VARIANCE', note: 'Double fault props carry high match-to-match variance (~40% CV). Even strong edges should be sized conservatively.' },
    ],
    confidence: 'LOW', // DFs are too volatile for MEDIUM without 30+ surface matches
  };
}

// ─── Total Breaks ─────────────────────────────────────────────────────────────

/**
 * Fair probability for total breaks of serve over/under.
 * Expected breaks per set = (1 - holdA) × serveGamesA + (1 - holdB) × serveGamesB
 *   where serveGamesA ≈ serveGamesB ≈ 6 (per set)
 */
function totalBreaksFairProb(prop, matchModel) {
  const breaksPerSet = ((1 - matchModel.holdA) + (1 - matchModel.holdB)) * 6 / 2;
  const expectedBreaks = parseFloat((breaksPerSet * matchModel.avgSets).toFixed(1));
  const sd = Math.max(1.2, expectedBreaks * 0.32);
  const z = (prop.line - expectedBreaks) / sd;
  const pUnder = normalCDF(z);
  const fairProb = prop.side === 'over' ? 1 - pUnder : pUnder;

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `Expected breaks: ~${expectedBreaks} (holdA: ${(matchModel.holdA*100).toFixed(1)}%, holdB: ${(matchModel.holdB*100).toFixed(1)}%, avg sets: ${matchModel.avgSets.toFixed(2)}).`,
      `Line: ${prop.line}, z=${z.toFixed(2)}.`,
    ],
    correlations: [
      { tag: 'STRUCTURAL', note: 'Break rate is a first-order derived stat from hold rates — use only when hold rates are HIGH reliability.' },
    ],
    confidence: 'MEDIUM',
  };
}

// ─── Player Games Won ─────────────────────────────────────────────────────────

/**
 * Fair probability for player total games won over/under.
 * Expected games won by A = holdA × A's serving games + (1-holdB) × B's serving games
 */
function playerGamesWonFairProb(prop, matchModel, playerLabel) {
  const totalServingGames = matchModel.avgSets * 6;
  const aServingGames = totalServingGames / 2;
  const bServingGames = totalServingGames / 2;

  const expectedGamesWon = playerLabel === 'A'
    ? parseFloat((matchModel.holdA * aServingGames + (1 - matchModel.holdB) * bServingGames).toFixed(1))
    : parseFloat((matchModel.holdB * bServingGames + (1 - matchModel.holdA) * aServingGames).toFixed(1));

  const sd = matchModel.format === 'bo5' ? 3.0 : 2.2;
  const z = (prop.line - expectedGamesWon) / sd;
  const pUnder = normalCDF(z);
  const fairProb = prop.side === 'over' ? 1 - pUnder : pUnder;

  return {
    fairProb: parseFloat(fairProb.toFixed(4)),
    reasoning: [
      `Player ${playerLabel} expected games won: ~${expectedGamesWon} (hold ${(matchModel['hold'+playerLabel]*100).toFixed(1)}%).`,
      `Line: ${prop.line}, z=${z.toFixed(2)}.`,
    ],
    correlations: [
      { tag: 'STRUCTURAL', note: 'Player games won is correlated with ML — if backing a strong underdog ML, consider fading their games won as a hedge.' },
    ],
    confidence: 'MEDIUM',
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Main prop pricing router. Returns fair probability + reasoning for any supported market.
 *
 * @param {object} prop         - { market, side, line, bookOdds }
 * @param {object} matchModel   - output of buildMatchModel()
 * @param {object} playerA      - player A stats
 * @param {object} playerB      - player B stats
 * @returns {object} { fairProb, reasoning, correlations, confidence } | null
 */
function priceProp(prop, matchModel, playerA, playerB) {
  switch (prop.market) {
    case 'total_games':
      return totalGamesFairProb(prop, matchModel, playerA, playerB);
    case 'total_sets':
      return totalSetsFairProb(prop, matchModel);
    case 'set_spread':
      return setSpreadFairProb(prop, matchModel);
    case 'player_aces': {
      const pl = prop.side === 'A' || prop.side === 'player_a' ? playerA : playerB;
      const lb = prop.side === 'A' || prop.side === 'player_a' ? 'A' : 'B';
      return playerAcesFairProb(prop, matchModel, pl, lb);
    }
    case 'player_double_faults': {
      const pl = prop.side === 'A' || prop.side === 'player_a' ? playerA : playerB;
      const lb = prop.side === 'A' || prop.side === 'player_a' ? 'A' : 'B';
      return playerDfFairProb(prop, matchModel, pl, lb);
    }
    case 'total_breaks':
      return totalBreaksFairProb(prop, matchModel);
    case 'player_games_won': {
      const lb = prop.side === 'A' || prop.side === 'player_a' ? 'A' : 'B';
      return playerGamesWonFairProb(prop, matchModel, lb);
    }
    default:
      return null;
  }
}

module.exports = { priceProp, totalGamesFairProb, totalSetsFairProb, setSpreadFairProb, playerAcesFairProb, playerDfFairProb, totalBreaksFairProb, playerGamesWonFairProb };
