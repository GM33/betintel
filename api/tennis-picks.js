// api/tennis-picks.js
// BetIntel Tennis Picks Engine — v2
//
// v2 upgrades over v1 (patched):
//   1. No-vig pricing: edge is now measured vs fair market baseline, not raw implied prob
//   2. Serve+return weighted match model: replaces hold-rate-only probability engine
//   3. Prop-native models: each prop type has its own dedicated estimator
//   4. Backtest scaffolding: calibration pipeline available via _lib/backtest.js
//   5. All seven v1 bugs are retained-fixed; no regressions
//
// POST /api/tennis-picks
// See request body schema at the bottom of this file.

'use strict';

const { noVig, edgeVsNoVig, auditMarket, americanToImplied } = require('./_lib/no-vig');
const { buildMatchModel }                                     = require('./_lib/match-model');
const { priceProp }                                           = require('./_lib/prop-models');

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_EDGE_PTS               = 3;    // minimum pts vs no-vig baseline to flag BET
const MIN_SAMPLE_MATCHES         = 12;
const GOOD_SAMPLE_MATCHES        = 25;
const NARRATIVE_INFLATION_THRESHOLD = 18;

// ─── Utilities (shared, kept local for API isolation) ─────────────────────────

function impliedToAmerican(prob) {
  if (prob <= 0 || prob >= 1) throw new Error('prob must be between 0 and 1');
  return prob >= 0.5
    ? -Math.round((prob / (1 - prob)) * 100)
    : Math.round(((1 - prob) / prob) * 100);
}

function auditPlayerStats(stats, surface, statSurface) {
  const flags = [];
  let reliability = 'HIGH';
  if (statSurface && statSurface.toLowerCase() !== surface.toLowerCase()) {
    flags.push(`SURFACE_MISMATCH: stats from ${statSurface}, match on ${surface}`);
    reliability = 'LOW';
  }
  const n = stats.surfaceMatches || 0;
  if (n < MIN_SAMPLE_MATCHES) {
    flags.push(`THIN_SAMPLE: only ${n} surface matches (min ${MIN_SAMPLE_MATCHES})`);
    reliability = 'LOW';
  } else if (n < GOOD_SAMPLE_MATCHES) {
    flags.push(`BORDERLINE_SAMPLE: ${n} surface matches (threshold: ${GOOD_SAMPLE_MATCHES})`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }
  if (stats.holdRate && (stats.holdRate > 0.97 || stats.holdRate < 0.55)) {
    flags.push(`OUTLIER_RISK: holdRate ${(stats.holdRate*100).toFixed(1)}% outside normal range`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }
  return { reliable: reliability !== 'LOW', reliability, flags, sampleSize: n };
}

function scoreFatigueAsymmetry(contextA, contextB) {
  const diff    = (contextA.setsPlayedLast2Rounds || 0) - (contextB.setsPlayedLast2Rounds || 0);
  const restDiff = (contextB.daysSinceLastMatch || 1) - (contextA.daysSinceLastMatch || 1);
  let fatiguedPlayer = 'EVEN', magnitude = 0;
  let edgeNote = 'No significant fatigue asymmetry detected.';

  if (diff >= 4) {
    fatiguedPlayer = 'A'; magnitude = diff;
    edgeNote = `Player A played ${diff} more sets in last 2 rounds — significant conditioning disadvantage. Underdog ML likely underpriced by 4–8 pts.`;
  } else if (diff <= -4) {
    fatiguedPlayer = 'B'; magnitude = Math.abs(diff);
    edgeNote = `Player B played ${Math.abs(diff)} more sets in last 2 rounds — significant conditioning disadvantage.`;
  } else if (Math.abs(diff) >= 2) {
    fatiguedPlayer = diff > 0 ? 'A' : 'B'; magnitude = Math.abs(diff);
    edgeNote = `Moderate fatigue edge: Player ${fatiguedPlayer} played ${magnitude} more sets in last 2 rounds.`;
  }
  if (restDiff >= 2)  edgeNote += ` Player A also has ${Math.abs(restDiff)} fewer rest days.`;
  else if (restDiff <= -2) edgeNote += ` Player B also has ${Math.abs(restDiff)} fewer rest days.`;

  return { fatiguedPlayer, setDiff: diff, restDiff, magnitude, edgeNote };
}

function detectNarrativeInflation(currentImplied, priorImplied, triggerEvent) {
  const shiftPts = parseFloat(((currentImplied - priorImplied) * 100).toFixed(2));
  const inflated = shiftPts >= NARRATIVE_INFLATION_THRESHOLD;
  return {
    inflated, shiftPts,
    warning: inflated
      ? `NARRATIVE_INFLATION: Line shifted +${shiftPts}pts after "${triggerEvent}". Favorite likely overpriced.`
      : `Line shift of ${shiftPts}pts after "${triggerEvent}" — within normal range.`,
  };
}

function runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, impliedProb) {
  const fails = [];
  if ((prop.side === 'B' || prop.side === 'underdog_plus') &&
      fatigueScore.fatiguedPlayer === 'B' && fatigueScore.magnitude >= 4) {
    fails.push('Underdog (B) played 4+ more sets than favorite — fatigue edge flipped.');
  }
  if (prop.market === 'ml' && prop.side === 'B' && impliedProb > 0.40) {
    fails.push('Underdog ML implied probability already above 40% — upset likely priced in.');
  }
  if (playerA.statSurface && playerA.statSurface !== matchContext.surface)
    fails.push(`Player A stats from ${playerA.statSurface}, match on ${matchContext.surface}.`);
  if (playerB.statSurface && playerB.statSurface !== matchContext.surface)
    fails.push(`Player B stats from ${playerB.statSurface}, match on ${matchContext.surface}.`);
  if ((playerA.surfaceMatches || 0) < MIN_SAMPLE_MATCHES &&
      (playerB.surfaceMatches || 0) < MIN_SAMPLE_MATCHES) {
    fails.push(`Both players have fewer than ${MIN_SAMPLE_MATCHES} surface matches. Insufficient data.`);
  }
  return fails;
}

// ─── Core Prop Evaluator ──────────────────────────────────────────────────────

function evaluateProp(prop, playerA, playerB, matchContext, matchModel, fatigueScore) {
  const rawImplied = americanToImplied(prop.bookOdds);

  // ── No-vig baseline ──────────────────────────────────────────────────────────
  // For ML and two-sided markets, we need the opposite side odds.
  // Prop object may carry bookOddsOpp for two-sided markets.
  let noVigProb = rawImplied; // fallback: single-side (no vig removal possible)
  let vigPct    = null;
  let noVigMethod = 'single-side-fallback';

  if (prop.bookOddsOpp && typeof prop.bookOddsOpp === 'number') {
    try {
      const nv = noVig(prop.bookOdds, prop.bookOddsOpp);
      noVigProb   = nv.fairA;  // fairA = no-vig prob for the side we're evaluating
      vigPct      = nv.vigPct;
      noVigMethod = nv.method;
    } catch (_) {}
  }

  // ── Fair probability from prop model ────────────────────────────────────────
  let priced = null;

  if (prop.market === 'ml') {
    // ML uses match model directly
    const fairProb = prop.side === 'A' ? matchModel.fairProbA : matchModel.fairProbB;
    const nvForML  = prop.side === 'A' ? noVigProb : (prop.bookOddsOpp ? noVig(prop.bookOddsOpp, prop.bookOdds).fairA : rawImplied);
    priced = {
      fairProb,
      reasoning: [],
      correlations: [],
      confidence: 'MEDIUM',
    };
    if (fatigueScore.magnitude >= 4) {
      priced.reasoning.push(fatigueScore.edgeNote);
      priced.correlations.push({ tag: 'UNDERRATED', note: 'Fatigue asymmetry of 4+ sets — late-match serve degradation increases break frequency for fatigued player.' });
    }
  } else {
    priced = priceProp(prop, matchModel, playerA, playerB);
  }

  if (!priced) {
    return {
      market: prop.market, side: prop.side, bookOdds: prop.bookOdds,
      verdict: 'NO BET — market not supported',
      reasoning: [`Market "${prop.market}" not yet supported.`],
    };
  }

  // ── Edge vs no-vig baseline (v2 core improvement) ────────────────────────────
  const edge = edgeVsNoVig(priced.fairProb, noVigProb);

  // ── Confidence from audit + prop model ──────────────────────────────────────
  const auditA = auditPlayerStats(playerA, matchContext.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, matchContext.surface, playerB.statSurface);
  let confidence = priced.confidence || 'LOW';
  if (prop.market === 'ml') {
    if (auditA.reliability === 'HIGH' && auditB.reliability === 'HIGH') confidence = 'HIGH';
    else if (auditA.reliability !== 'LOW' && auditB.reliability !== 'LOW') confidence = 'MEDIUM';
    else confidence = 'LOW';
  }

  // ── Hard filters ─────────────────────────────────────────────────────────────
  const hardFilterFails = runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, rawImplied);
  if (hardFilterFails.length > 0) {
    return {
      market: prop.market, side: prop.side, line: prop.line || null,
      bookOdds: prop.bookOdds,
      impliedProb:  `${(rawImplied*100).toFixed(1)}%`,
      noVigProb:    `${(noVigProb*100).toFixed(1)}%`,
      vigPct:       vigPct !== null ? `${vigPct}%` : 'N/A',
      fairProb:     `${(priced.fairProb*100).toFixed(1)}%`,
      edgePts:      `${edge > 0 ? '+' : ''}${edge}`,
      confidence:   'LOW',
      verdict:      'NO BET',
      reasoning:    hardFilterFails.map(f => `HARD FILTER: ${f}`),
      correlations: [],
    };
  }

  // ── Verdict ───────────────────────────────────────────────────────────────────
  const verdict = edge >= MIN_EDGE_PTS
    ? 'BET'
    : edge >= 2
    ? 'MARGINAL — edge below 3pt threshold'
    : 'NO BET';

  return {
    market:      prop.market,
    side:        prop.side,
    line:        prop.line || null,
    bookOdds:    prop.bookOdds,
    impliedProb: `${(rawImplied*100).toFixed(1)}%`,
    noVigProb:   `${(noVigProb*100).toFixed(1)}%`,
    vigPct:      vigPct !== null ? `${vigPct}%` : 'N/A (single-side)',
    noVigMethod,
    fairProb:    `${(priced.fairProb*100).toFixed(1)}%`,
    edgePts:     `${edge > 0 ? '+' : ''}${edge}`,
    confidence,
    verdict,
    reasoning:    priced.reasoning,
    correlations: priced.correlations,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/tennis-picks
 *
 * Request body:
 * {
 *   match: {
 *     surface: 'clay'|'grass'|'hard'|'indoor_hard',
 *     format: 'bo3'|'bo5',
 *     tournament: string,
 *     round: string,
 *     narrativeTrigger?: string,  // e.g. 'Beat Djokovic R3'
 *   },
 *   playerA: {
 *     name: string,
 *     holdRate?: number,            // fallback if serve stats absent
 *     surfaceMatches?: number,
 *     statSurface?: string,
 *     // Full serve stats (preferred over holdRate):
 *     firstServePct?: number,       // e.g. 0.62
 *     firstServeWonPct?: number,    // e.g. 0.72
 *     secondServeWonPct?: number,   // e.g. 0.52
 *     aceRatePerGame?: number,      // aces per service game, e.g. 0.55
 *     dfRatePerGame?: number,       // double faults per service game, e.g. 0.28
 *     // Return stats (improves accuracy):
 *     returnPtsWonOnFirst?: number, // e.g. 0.28
 *     returnPtsWonOnSecond?: number,// e.g. 0.52
 *     breakPct?: number,            // e.g. 0.22
 *     // Prop-specific:
 *     injuryFlag?: string,          // free text, e.g. 'hamstring tightness'
 *   },
 *   playerB: { ...same shape },
 *   contextA?: { setsPlayedLast2Rounds?: number, daysSinceLastMatch?: number },
 *   contextB?: { ...same shape },
 *   priorOddsA?: number,            // American odds 24–48h ago for narrative inflation check
 *   props: [
 *     {
 *       market: 'ml'|'total_games'|'total_sets'|'set_spread'|
 *               'player_aces'|'player_double_faults'|'total_breaks'|'player_games_won',
 *       side: string,               // 'A'|'B'|'over'|'under'|'underdog_plus'|'favorite_minus'|'player_a'|'player_b'
 *       line?: number,              // required for total markets
 *       bookOdds: number,           // American odds for THIS side
 *       bookOddsOpp?: number,       // American odds for opposite side (enables vig removal)
 *     }
 *   ]
 * }
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }

  const { match, playerA, playerB, contextA, contextB, priorOddsA, props } = body || {};

  const missing = [];
  if (!match?.surface)   missing.push('match.surface');
  if (!match?.format)    missing.push('match.format');
  if (!playerA)          missing.push('playerA');
  if (!playerB)          missing.push('playerB');
  if (!Array.isArray(props) || !props.length) missing.push('props[]');
  if (missing.length) return res.status(400).json({ error: 'Missing required fields.', missingFields: missing });

  // ── Build match model once, reuse for all props ──────────────────────────────
  const fatigueScore = scoreFatigueAsymmetry(
    { setsPlayedLast2Rounds: contextA?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextA?.daysSinceLastMatch || 1 },
    { setsPlayedLast2Rounds: contextB?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextB?.daysSinceLastMatch || 1 }
  );

  const matchModel = buildMatchModel(playerA, playerB, match.surface, match.format, fatigueScore);
  const matchContext = { surface: match.surface, format: match.format };

  // ── Audit ─────────────────────────────────────────────────────────────────────
  const auditA = auditPlayerStats(playerA, match.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, match.surface, playerB.statSurface);

  // ── Narrative inflation check ────────────────────────────────────────────────
  let inflationCheck = null;
  if (priorOddsA) {
    try {
      const currentML = props.find(p => p.market === 'ml' && (p.side === 'A' || p.side === 'B'));
      if (currentML) {
        const currentImplied = americanToImplied(currentML.bookOdds);
        const priorImplied   = americanToImplied(priorOddsA);
        inflationCheck = detectNarrativeInflation(currentImplied, priorImplied, match.narrativeTrigger || 'recent notable win');
      }
    } catch (_) {}
  }

  // ── Market-level vig audit (if ML both sides provided) ───────────────────────
  let marketVigAudit = null;
  const mlA = props.find(p => p.market === 'ml' && p.side === 'A');
  const mlB = props.find(p => p.market === 'ml' && p.side === 'B');
  if (mlA?.bookOddsOpp || mlB?.bookOddsOpp || (mlA && mlB)) {
    try {
      const oddsA = mlA?.bookOdds;
      const oddsB = mlB?.bookOdds || mlA?.bookOddsOpp;
      if (oddsA && oddsB) marketVigAudit = auditMarket(oddsA, oddsB, matchModel.fairProbA);
    } catch (_) {}
  }

  // ── Evaluate all props ────────────────────────────────────────────────────────
  const results = props.map(prop => {
    const r = evaluateProp(prop, playerA, playerB, matchContext, matchModel, fatigueScore);
    if (prop.market === 'ml' && inflationCheck?.inflated) {
      r.reasoning = [inflationCheck.warning, ...(r.reasoning || [])];
    }
    return r;
  });

  // ── Summary ───────────────────────────────────────────────────────────────────
  const bets     = results.filter(r => r.verdict === 'BET');
  const marginal = results.filter(r => r.verdict?.startsWith('MARGINAL'));
  const noBets   = results.filter(r => r.verdict?.startsWith('NO BET'));

  return res.status(200).json({
    meta: {
      generatedAt: new Date().toISOString(),
      engineVersion: 'v2-serve-return-no-vig',
      match: {
        playerA: playerA.name || 'Player A',
        playerB: playerB.name || 'Player B',
        surface: match.surface,
        format:  match.format,
        tournament: match.tournament || '',
        round:   match.round || '',
      },
    },
    matchModel: {
      holdA:     `${(matchModel.holdA*100).toFixed(1)}%`,
      holdB:     `${(matchModel.holdB*100).toFixed(1)}%`,
      pAWinsSet: `${(matchModel.pAWinsSet*100).toFixed(1)}%`,
      fairProbA: `${(matchModel.fairProbA*100).toFixed(1)}%`,
      fairProbB: `${(matchModel.fairProbB*100).toFixed(1)}%`,
      avgSets:   matchModel.avgSets.toFixed(2),
      modelVersion: matchModel.modelVersion,
    },
    audit: {
      playerA: { name: playerA.name, ...auditA },
      playerB: { name: playerB.name, ...auditB },
    },
    fatigueAnalysis:  fatigueScore,
    narrativeInflation: inflationCheck,
    marketVigAudit,
    picks: results,
    summary: {
      totalProps:  results.length,
      bets:        bets.length,
      marginal:    marginal.length,
      noBets:      noBets.length,
      topBets:     bets.map(b => `${b.market} ${b.side} (${b.edgePts}pts vs no-vig, ${b.confidence})`),
      vigNote:     marketVigAudit ? `Market vig: ${marketVigAudit.vigPct}% (${marketVigAudit.method}). Edge measured vs no-vig baseline.` : 'Provide bookOddsOpp on props for vig removal.',
      marketEfficiencyNote: bets.length === 0 && marginal.length === 0
        ? 'No edge meets 3pt threshold vs no-vig baseline. Pass all markets.'
        : null,
    },
  });
};
