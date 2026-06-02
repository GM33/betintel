// api/tennis-picks.js
// BetIntel Tennis Picks Engine — v2.1
//
// v2.1 adds over v2:
//   1. Auto-injects bookOddsOpp from live odds feed (tennis-odds-bridge.js)
//      so no-vig removal fires automatically — no manual passing required
//   2. Auto-logs every BET/MARGINAL pick to Redis (picks-store.js)
//      feeding the calibration pipeline (api/calibration.js)
//   3. Returns pickIds in response so caller can resolve outcomes later
//
// POST /api/tennis-picks
// See request body schema at bottom of this file.

'use strict';

const { noVig, edgeVsNoVig, auditMarket, americanToImplied } = require('./_lib/no-vig');
const { buildMatchModel }                                     = require('./_lib/match-model');
const { priceProp }                                           = require('./_lib/prop-models');
const { enrichPropsWithOpp }                                  = require('./_lib/tennis-odds-bridge');
const { logPicks }                                            = require('./_lib/picks-store');

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_EDGE_PTS                = 3;
const MIN_SAMPLE_MATCHES          = 12;
const GOOD_SAMPLE_MATCHES         = 25;
const NARRATIVE_INFLATION_THRESHOLD = 18;

// ─── Utilities ────────────────────────────────────────────────────────────────

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
    flags.push(`OUTLIER_RISK: holdRate ${(stats.holdRate * 100).toFixed(1)}% outside normal range`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }
  return { reliable: reliability !== 'LOW', reliability, flags, sampleSize: n };
}

function scoreFatigueAsymmetry(contextA, contextB) {
  const diff     = (contextA.setsPlayedLast2Rounds || 0) - (contextB.setsPlayedLast2Rounds || 0);
  const restDiff = (contextB.daysSinceLastMatch || 1) - (contextA.daysSinceLastMatch || 1);
  let fatiguedPlayer = 'EVEN', magnitude = 0;
  let edgeNote = 'No significant fatigue asymmetry detected.';
  if (diff >= 4) {
    fatiguedPlayer = 'A'; magnitude = diff;
    edgeNote = `Player A played ${diff} more sets in last 2 rounds — significant conditioning disadvantage.`;
  } else if (diff <= -4) {
    fatiguedPlayer = 'B'; magnitude = Math.abs(diff);
    edgeNote = `Player B played ${Math.abs(diff)} more sets in last 2 rounds — significant conditioning disadvantage.`;
  } else if (Math.abs(diff) >= 2) {
    fatiguedPlayer = diff > 0 ? 'A' : 'B'; magnitude = Math.abs(diff);
    edgeNote = `Moderate fatigue edge: Player ${fatiguedPlayer} played ${magnitude} more sets in last 2 rounds.`;
  }
  if (restDiff >= 2)       edgeNote += ` Player A also has ${Math.abs(restDiff)} fewer rest days.`;
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

function runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, rawImplied) {
  const fails = [];
  if ((prop.side === 'B' || prop.side === 'underdog_plus') &&
      fatigueScore.fatiguedPlayer === 'B' && fatigueScore.magnitude >= 4) {
    fails.push('Underdog (B) played 4+ more sets than favorite — fatigue edge flipped.');
  }
  if (prop.market === 'ml' && prop.side === 'B' && rawImplied > 0.40) {
    fails.push('Underdog ML implied probability already above 40% — upset likely priced in.');
  }
  if (playerA.statSurface && playerA.statSurface !== matchContext.surface)
    fails.push(`Player A stats from ${playerA.statSurface}, match on ${matchContext.surface}.`);
  if (playerB.statSurface && playerB.statSurface !== matchContext.surface)
    fails.push(`Player B stats from ${playerB.statSurface}, match on ${matchContext.surface}.`);
  if ((playerA.surfaceMatches || 0) < MIN_SAMPLE_MATCHES &&
      (playerB.surfaceMatches || 0) < MIN_SAMPLE_MATCHES) {
    fails.push(`Both players have fewer than ${MIN_SAMPLE_MATCHES} surface matches.`);
  }
  return fails;
}

// ─── Core Evaluator ───────────────────────────────────────────────────────────

function evaluateProp(prop, playerA, playerB, matchContext, matchModel, fatigueScore) {
  const rawImplied = americanToImplied(prop.bookOdds);

  // No-vig baseline
  let noVigProb = rawImplied;
  let vigPct    = null;
  let noVigMethod = 'single-side-fallback';
  if (prop.bookOddsOpp && typeof prop.bookOddsOpp === 'number') {
    try {
      const nv = noVig(prop.bookOdds, prop.bookOddsOpp);
      noVigProb   = nv.fairA;
      vigPct      = nv.vigPct;
      noVigMethod = nv.method;
    } catch (_) {}
  }

  // Fair probability
  let priced = null;
  if (prop.market === 'ml') {
    const fairProb = prop.side === 'A' ? matchModel.fairProbA : matchModel.fairProbB;
    priced = {
      fairProb,
      reasoning: fatigueScore.magnitude >= 4 ? [fatigueScore.edgeNote] : [],
      correlations: fatigueScore.magnitude >= 4
        ? [{ tag: 'UNDERRATED', note: 'Fatigue asymmetry of 4+ sets — late-match serve degradation increases break frequency.' }]
        : [],
      confidence: 'MEDIUM',
    };
  } else {
    priced = priceProp(prop, matchModel, playerA, playerB);
  }

  if (!priced) {
    return { market: prop.market, side: prop.side, bookOdds: prop.bookOdds,
      verdict: `NO BET — market "${prop.market}" not supported.`, reasoning: [], correlations: [] };
  }

  const edge = edgeVsNoVig(priced.fairProb, noVigProb);

  const auditA = auditPlayerStats(playerA, matchContext.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, matchContext.surface, playerB.statSurface);
  let confidence = priced.confidence || 'LOW';
  if (prop.market === 'ml') {
    if (auditA.reliability === 'HIGH' && auditB.reliability === 'HIGH') confidence = 'HIGH';
    else if (auditA.reliability !== 'LOW' && auditB.reliability !== 'LOW') confidence = 'MEDIUM';
    else confidence = 'LOW';
  }

  const hardFilterFails = runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, rawImplied);
  if (hardFilterFails.length > 0) {
    return {
      market: prop.market, side: prop.side, line: prop.line || null,
      bookOdds: prop.bookOdds, bookOddsOpp: prop.bookOddsOpp || null,
      impliedProb: `${(rawImplied*100).toFixed(1)}%`,
      noVigProb:   `${(noVigProb*100).toFixed(1)}%`,
      vigPct:      vigPct !== null ? `${vigPct}%` : 'N/A',
      fairProb:    `${(priced.fairProb*100).toFixed(1)}%`,
      edgePts:     `${edge > 0 ? '+' : ''}${edge}`,
      confidence:  'LOW', verdict: 'NO BET',
      reasoning:   hardFilterFails.map(f => `HARD FILTER: ${f}`),
      correlations: [],
    };
  }

  const verdict = edge >= MIN_EDGE_PTS ? 'BET'
    : edge >= 2 ? 'MARGINAL — edge below 3pt threshold'
    : 'NO BET';

  return {
    market: prop.market, side: prop.side, line: prop.line || null,
    bookOdds: prop.bookOdds, bookOddsOpp: prop.bookOddsOpp || null,
    impliedProb:  `${(rawImplied*100).toFixed(1)}%`,
    noVigProb:    `${(noVigProb*100).toFixed(1)}%`,
    vigPct:       vigPct !== null ? `${vigPct}%` : 'N/A (single-side)',
    noVigMethod,
    fairProb:     `${(priced.fairProb*100).toFixed(1)}%`,
    edgePts:      `${edge > 0 ? '+' : ''}${edge}`,
    confidence, verdict,
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
 *     format:  'bo3'|'bo5',
 *     tournament?: string,
 *     round?: string,
 *     narrativeTrigger?: string,
 *     sportKey?: string,   // override Odds API sport key for auto-enrichment
 *   },
 *   playerA: {
 *     name: string,
 *     holdRate?: number,
 *     surfaceMatches?: number,
 *     statSurface?: string,
 *     firstServePct?: number,
 *     firstServeWonPct?: number,
 *     secondServeWonPct?: number,
 *     aceRatePerGame?: number,
 *     dfRatePerGame?: number,
 *     returnPtsWonOnFirst?: number,
 *     returnPtsWonOnSecond?: number,
 *     breakPct?: number,
 *     injuryFlag?: string,
 *   },
 *   playerB: { ...same shape },
 *   contextA?: { setsPlayedLast2Rounds?: number, daysSinceLastMatch?: number },
 *   contextB?: { ...same shape },
 *   priorOddsA?: number,
 *   autoEnrichOdds?: boolean,  // default true — auto-inject bookOddsOpp from live feed
 *   props: [
 *     {
 *       market: 'ml'|'total_games'|'total_sets'|'set_spread'|
 *               'player_aces'|'player_double_faults'|'total_breaks'|'player_games_won',
 *       side: string,
 *       line?: number,
 *       bookOdds: number,
 *       bookOddsOpp?: number,  // auto-injected if autoEnrichOdds=true and event found
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
  const autoEnrich = body?.autoEnrichOdds !== false; // default true

  const missing = [];
  if (!match?.surface) missing.push('match.surface');
  if (!match?.format)  missing.push('match.format');
  if (!playerA)        missing.push('playerA');
  if (!playerB)        missing.push('playerB');
  if (!Array.isArray(props) || !props.length) missing.push('props[]');
  if (missing.length) return res.status(400).json({ error: 'Missing required fields.', missingFields: missing });

  // ── Step 1: Auto-enrich bookOddsOpp from live odds feed ───────────────────
  let enrichedProps = props;
  let oddsEnrichment = { attempted: false, eventFound: false, bookmakerUsed: null, vigAudit: null };

  if (autoEnrich && playerA.name && playerB.name) {
    try {
      const bridgeResult = await enrichPropsWithOpp(
        playerA.name, playerB.name, props, match.sportKey
      );
      enrichedProps = bridgeResult.props;
      oddsEnrichment = {
        attempted:     true,
        eventFound:    bridgeResult.eventFound,
        eventId:       bridgeResult.eventId || null,
        bookmakerUsed: bridgeResult.bookmakerUsed || null,
        vigAudit:      bridgeResult.vigAudit || null,
        error:         bridgeResult.error || null,
      };
    } catch (err) {
      oddsEnrichment = { attempted: true, eventFound: false, error: err.message };
    }
  }

  // ── Step 2: Build match model ──────────────────────────────────────────────
  const fatigueScore = scoreFatigueAsymmetry(
    { setsPlayedLast2Rounds: contextA?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextA?.daysSinceLastMatch || 1 },
    { setsPlayedLast2Rounds: contextB?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextB?.daysSinceLastMatch || 1 }
  );

  const matchModel   = buildMatchModel(playerA, playerB, match.surface, match.format, fatigueScore);
  const matchContext = { surface: match.surface, format: match.format };

  // ── Step 3: Data audit ────────────────────────────────────────────────────
  const auditA = auditPlayerStats(playerA, match.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, match.surface, playerB.statSurface);

  // ── Step 4: Narrative inflation check ────────────────────────────────────
  let inflationCheck = null;
  if (priorOddsA) {
    try {
      const currentML = enrichedProps.find(p => p.market === 'ml');
      if (currentML) {
        inflationCheck = detectNarrativeInflation(
          americanToImplied(currentML.bookOdds),
          americanToImplied(priorOddsA),
          match.narrativeTrigger || 'recent notable win'
        );
      }
    } catch (_) {}
  }

  // ── Step 5: Market vig audit ──────────────────────────────────────────────
  let marketVigAudit = oddsEnrichment.vigAudit || null;
  if (!marketVigAudit) {
    const mlA = enrichedProps.find(p => p.market === 'ml' && p.side === 'A');
    const mlB = enrichedProps.find(p => p.market === 'ml' && p.side === 'B');
    const oddsA = mlA?.bookOdds;
    const oddsB = mlB?.bookOdds || mlA?.bookOddsOpp;
    if (oddsA && oddsB) {
      try { marketVigAudit = auditMarket(oddsA, oddsB, matchModel.fairProbA); } catch (_) {}
    }
  }

  // ── Step 6: Evaluate all props ────────────────────────────────────────────
  const results = enrichedProps.map(prop => {
    const r = evaluateProp(prop, playerA, playerB, matchContext, matchModel, fatigueScore);
    if (prop.market === 'ml' && inflationCheck?.inflated) {
      r.reasoning = [inflationCheck.warning, ...(r.reasoning || [])];
    }
    return r;
  });

  // ── Step 7: Auto-log BET + MARGINAL picks to Redis ────────────────────────
  const generatedAt = new Date().toISOString();
  let pickIds = [];
  const logMeta = {
    matchId:    oddsEnrichment.eventId || `${playerA.name}-vs-${playerB.name}-${generatedAt.slice(0,10)}`,
    playerA:    playerA.name || 'Player A',
    playerB:    playerB.name || 'Player B',
    surface:    match.surface,
    format:     match.format,
    tournament: match.tournament || '',
    round:      match.round || '',
    generatedAt,
  };
  try {
    pickIds = await logPicks(logMeta, results, matchModel);
  } catch (err) {
    console.warn('[tennis-picks] picks logging failed:', err.message);
  }

  // ── Step 8: Build response ────────────────────────────────────────────────
  const bets     = results.filter(r => r.verdict === 'BET');
  const marginal = results.filter(r => r.verdict?.startsWith('MARGINAL'));
  const noBets   = results.filter(r => r.verdict?.startsWith('NO BET'));

  return res.status(200).json({
    meta: {
      generatedAt,
      engineVersion: 'v2.1-auto-vig-logged',
      match: {
        playerA:    playerA.name || 'Player A',
        playerB:    playerB.name || 'Player B',
        surface:    match.surface,
        format:     match.format,
        tournament: match.tournament || '',
        round:      match.round || '',
      },
    },
    matchModel: {
      holdA:        `${(matchModel.holdA*100).toFixed(1)}%`,
      holdB:        `${(matchModel.holdB*100).toFixed(1)}%`,
      pAWinsSet:    `${(matchModel.pAWinsSet*100).toFixed(1)}%`,
      fairProbA:    `${(matchModel.fairProbA*100).toFixed(1)}%`,
      fairProbB:    `${(matchModel.fairProbB*100).toFixed(1)}%`,
      avgSets:      matchModel.avgSets.toFixed(2),
      modelVersion: matchModel.modelVersion,
    },
    audit: {
      playerA: { name: playerA.name, ...auditA },
      playerB: { name: playerB.name, ...auditB },
    },
    oddsEnrichment,
    fatigueAnalysis:   fatigueScore,
    narrativeInflation: inflationCheck,
    marketVigAudit,
    picks: results,
    pickIds,
    summary: {
      totalProps:  results.length,
      bets:        bets.length,
      marginal:    marginal.length,
      noBets:      noBets.length,
      topBets:     bets.map(b => `${b.market} ${b.side} (${b.edgePts}pts vs no-vig, ${b.confidence})`),
      loggedPicks: pickIds.length,
      vigNote:     marketVigAudit
        ? `Market vig: ${marketVigAudit.vigPct}% (${marketVigAudit.method}). Edge vs no-vig baseline.`
        : oddsEnrichment.eventFound
          ? 'Event found in live feed but vig audit unavailable.'
          : 'Event not found in live feed — pass bookOddsOpp manually for vig removal.',
      marketEfficiencyNote: bets.length === 0 && marginal.length === 0
        ? 'No edge meets 3pt threshold vs no-vig baseline. Pass all markets.'
        : null,
    },
  });
};
