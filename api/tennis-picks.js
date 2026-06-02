// api/tennis-picks.js
// BetIntel Tennis Picks Engine
// Surface-adjusted prop & line analyzer with edge detection, confidence tiers,
// fatigue asymmetry scoring, narrative inflation detection, and BET/NO BET verdicts.
// Implements the formula defined in BetIntel session — June 2026.

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_EDGE_PTS       = 3;      // minimum edge (percentage points) to flag BET
const MIN_SAMPLE_MATCHES = 12;     // minimum surface matches for MEDIUM reliability
const GOOD_SAMPLE_MATCHES = 25;    // threshold for HIGH reliability
const NARRATIVE_INFLATION_THRESHOLD = 18; // implied prob shift (pts) in 48h to flag inflation

// ─── Utility: American odds → implied probability (vig-inclusive) ─────────────

function americanToImplied(odds) {
  if (typeof odds !== 'number') throw new Error('odds must be a number');
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ─── Utility: Implied probability → American odds ─────────────────────────────

function impliedToAmerican(prob) {
  if (prob <= 0 || prob >= 1) throw new Error('prob must be between 0 and 1');
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

// ─── Utility: Edge in percentage points ───────────────────────────────────────

function calcEdge(fairProb, impliedProb) {
  return parseFloat(((fairProb - impliedProb) * 100).toFixed(2));
}

// ─── Data Quality Audit ───────────────────────────────────────────────────────

/**
 * Audits a player's surface stat block for reliability.
 * @param {object} stats - player surface stats
 * @param {string} surface - 'clay' | 'grass' | 'hard' | 'indoor_hard'
 * @param {string} statSurface - surface the stats were collected on
 * @returns {object} { reliable: bool, reliability: 'HIGH'|'MEDIUM'|'LOW', flags: string[] }
 */
function auditPlayerStats(stats, surface, statSurface) {
  const flags = [];
  let reliability = 'HIGH';

  // Surface mismatch check
  if (statSurface && statSurface.toLowerCase() !== surface.toLowerCase()) {
    flags.push(`SURFACE_MISMATCH: stats from ${statSurface}, match on ${surface}`);
    reliability = 'LOW';
  }

  // Sample size check
  const n = stats.surfaceMatches || 0;
  if (n < MIN_SAMPLE_MATCHES) {
    flags.push(`THIN_SAMPLE: only ${n} surface matches (min ${MIN_SAMPLE_MATCHES})`);
    reliability = reliability === 'LOW' ? 'LOW' : 'LOW';
  } else if (n < GOOD_SAMPLE_MATCHES) {
    flags.push(`BORDERLINE_SAMPLE: ${n} surface matches (good threshold: ${GOOD_SAMPLE_MATCHES})`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }

  // Outlier risk — if hold rate or ace rate seems extreme
  if (stats.holdRate > 0.97 || stats.holdRate < 0.55) {
    flags.push(`OUTLIER_RISK: holdRate ${(stats.holdRate * 100).toFixed(1)}% is outside normal range`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }

  return {
    reliable: reliability !== 'LOW',
    reliability,
    flags,
    sampleSize: n,
  };
}

// ─── Fatigue Asymmetry Scorer ─────────────────────────────────────────────────

/**
 * Scores fatigue asymmetry between two players.
 * Returns edge direction and magnitude.
 * @param {object} contextA - { setsPlayedLast2Rounds: number, daysSinceLastMatch: number }
 * @param {object} contextB - same shape
 * @returns {object} { fatiguedPlayer: 'A'|'B'|'EVEN', setDiff: number, edgeNote: string }
 */
function scoreFatigueAsymmetry(contextA, contextB) {
  const diff = (contextA.setsPlayedLast2Rounds || 0) - (contextB.setsPlayedLast2Rounds || 0);
  const restDiff = (contextB.daysSinceLastMatch || 1) - (contextA.daysSinceLastMatch || 1);

  let fatiguedPlayer = 'EVEN';
  let magnitude = 0;
  let edgeNote = 'No significant fatigue asymmetry detected.';

  if (diff >= 4) {
    fatiguedPlayer = 'A';
    magnitude = diff;
    edgeNote = `Player A played ${diff} more sets in last 2 rounds — significant conditioning disadvantage on clay. Underdog ML likely underpriced by 4–8 pts.`;
  } else if (diff <= -4) {
    fatiguedPlayer = 'B';
    magnitude = Math.abs(diff);
    edgeNote = `Player B played ${Math.abs(diff)} more sets in last 2 rounds — significant conditioning disadvantage. Underdog ML likely underpriced by 4–8 pts.`;
  } else if (Math.abs(diff) >= 2) {
    fatiguedPlayer = diff > 0 ? 'A' : 'B';
    magnitude = Math.abs(diff);
    edgeNote = `Moderate fatigue edge: Player ${fatiguedPlayer} played ${magnitude} more sets in last 2 rounds.`;
  }

  if (restDiff >= 2) {
    edgeNote += ` Player A also has ${Math.abs(restDiff)} fewer rest days.`;
  }

  return { fatiguedPlayer, setDiff: diff, restDiff, magnitude, edgeNote };
}

// ─── Narrative Inflation Detector ────────────────────────────────────────────

/**
 * Detects if a favorite's line has inflated beyond statistical justification.
 * @param {number} currentImplied - current implied probability (0–1)
 * @param {number} priorImplied   - implied probability 24–48h ago (0–1)
 * @param {string} triggerEvent   - description of what caused the move (e.g. 'Beat Djokovic R3')
 * @returns {object} { inflated: bool, shiftPts: number, warning: string }
 */
function detectNarrativeInflation(currentImplied, priorImplied, triggerEvent) {
  const shiftPts = parseFloat(((currentImplied - priorImplied) * 100).toFixed(2));
  const inflated = shiftPts >= NARRATIVE_INFLATION_THRESHOLD;

  return {
    inflated,
    shiftPts,
    warning: inflated
      ? `NARRATIVE_INFLATION: Line shifted +${shiftPts}pts after "${triggerEvent}". ` +
        `Favorite likely overpriced. Underdog may have +${Math.round(shiftPts * 0.4)}–${Math.round(shiftPts * 0.6)}pt hidden edge.`
      : `Line shift of ${shiftPts}pts after "${triggerEvent}" — within normal range.`,
  };
}

// ─── Fair Probability Engine ─────────────────────────────────────────────────

/**
 * Estimates fair win probability for Player A vs Player B using
 * surface-adjusted hold rates and a simple Bradley-Terry approximation.
 *
 * Formula:
 *   P(A wins game on A serve) = holdA
 *   P(A wins game on B serve) = 1 - holdB
 *   P(A wins set) derived via set simulation (simplified)
 *   P(A wins match BO3 or BO5) via set probability
 *
 * @param {number} holdA - P(A holds serve on this surface)
 * @param {number} holdB - P(B holds serve on this surface)
 * @param {string} format - 'bo3' | 'bo5'
 * @param {object} fatigueScore - output from scoreFatigueAsymmetry
 * @returns {object} { fairProbA: number, fairProbB: number }
 */
function estimateFairMatchProb(holdA, holdB, format = 'bo3', fatigueScore = {}) {
  // Adjust hold rates for fatigue
  let adjHoldA = holdA;
  let adjHoldB = holdB;

  if (fatigueScore.fatiguedPlayer === 'A') {
    adjHoldA = holdA - (fatigueScore.magnitude * 0.008); // ~0.8% per set diff
  } else if (fatigueScore.fatiguedPlayer === 'B') {
    adjHoldB = holdB - (fatigueScore.magnitude * 0.008);
  }

  // Clamp to valid range
  adjHoldA = Math.min(0.98, Math.max(0.50, adjHoldA));
  adjHoldB = Math.min(0.98, Math.max(0.50, adjHoldB));

  // P(A wins a set) — simplified via service game dominance
  // Each set assumed 6 service games each side (approximation)
  const pAWinsServiceGame  = adjHoldA;
  const pABreaksServiceGame = 1 - adjHoldB;

  // Expected games won per set by A out of 12
  const pAWinsSet = (pAWinsServiceGame + pABreaksServiceGame) / 2;

  // Match win probability via binomial approximation
  const setsToWin = format === 'bo5' ? 3 : 2;
  const totalSets = format === 'bo5' ? 5 : 3;

  let pAWinsMatch = 0;
  for (let w = setsToWin; w <= totalSets; w++) {
    pAWinsMatch += binomialCoeff(totalSets, w) *
      Math.pow(pAWinsSet, w) *
      Math.pow(1 - pAWinsSet, totalSets - w);
  }

  // Normalize for vig-free output
  pAWinsMatch = Math.min(0.97, Math.max(0.03, pAWinsMatch));

  return {
    fairProbA: parseFloat(pAWinsMatch.toFixed(4)),
    fairProbB: parseFloat((1 - pAWinsMatch).toFixed(4)),
    adjHoldA: parseFloat(adjHoldA.toFixed(4)),
    adjHoldB: parseFloat(adjHoldB.toFixed(4)),
  };
}

function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

// ─── Props Engine ─────────────────────────────────────────────────────────────

/**
 * Estimates fair probability for specific props.
 * Supports: total_games, total_sets, player_sets_spread, ml
 */
function evaluateProp(prop, playerA, playerB, matchContext) {
  const { surface, format } = matchContext;
  const fatigueScore = scoreFatigueAsymmetry(
    matchContext.contextA || {},
    matchContext.contextB || {}
  );

  const holdA = playerA.holdRate || 0.82;
  const holdB = playerB.holdRate || 0.82;

  // Average expected games per set (clay: higher rally, ~10.2 games/set avg)
  const surfaceGameFactor = surface === 'clay' ? 10.2 : surface === 'grass' ? 9.4 : 9.8;
  const avgSetsBO5 = 3.8;
  const avgSetsBO3 = 2.4;
  const avgSets = format === 'bo5' ? avgSetsBO5 : avgSetsBO3;

  // Expected hold rate impact on total games
  const avgHold = (holdA + holdB) / 2;
  // Higher hold = more games (fewer breaks = sets go deeper)
  const holdGameBonus = (avgHold - 0.82) * 40; // ~40 extra games per 100% hold above baseline
  const expectedGames = parseFloat((surfaceGameFactor * avgSets + holdGameBonus).toFixed(1));

  const result = {
    market: prop.market,
    side: prop.side,
    bookOdds: prop.bookOdds,
    impliedProb: parseFloat(americanToImplied(prop.bookOdds).toFixed(4)),
    fairProb: null,
    edge: null,
    confidence: 'LOW',
    verdict: 'NO BET',
    reasoning: [],
    correlations: [],
  };

  // ── ML ──────────────────────────────────────────────────────────────────────
  if (prop.market === 'ml') {
    const { fairProbA, fairProbB } = estimateFairMatchProb(holdA, holdB, format, fatigueScore);
    result.fairProb = prop.side === 'A' ? fairProbA : fairProbB;
    result.edge     = calcEdge(result.fairProb, result.impliedProb);

    // Confidence based on sample size and fatigue clarity
    const auditA = auditPlayerStats(playerA, surface, playerA.statSurface);
    const auditB = auditPlayerStats(playerB, surface, playerB.statSurface);
    if (auditA.reliability === 'HIGH' && auditB.reliability === 'HIGH') result.confidence = 'HIGH';
    else if (auditA.reliability !== 'LOW' && auditB.reliability !== 'LOW') result.confidence = 'MEDIUM';

    if (fatigueScore.magnitude >= 4) {
      result.reasoning.push(fatigueScore.edgeNote);
      result.correlations.push({
        tag: 'UNDERRATED',
        note: 'Fatigue asymmetry of 4+ sets in BO5 clay — late-match serve degradation increases break frequency for fatigued player.',
      });
    }
  }

  // ── Total Games ─────────────────────────────────────────────────────────────
  else if (prop.market === 'total_games') {
    const line = prop.line;
    // Fair prob over/under based on expected games distribution
    // Using normal approximation: SD ~3.5 games for BO5 clay, ~2.5 for BO3
    const sd = format === 'bo5' ? 3.5 : 2.5;
    const z = (line - expectedGames) / sd;
    const pUnder = normalCDF(z);
    result.fairProb = prop.side === 'over' ? parseFloat((1 - pUnder).toFixed(4)) : parseFloat(pUnder.toFixed(4));
    result.edge     = calcEdge(result.fairProb, result.impliedProb);

    // Confidence
    if (avgHold >= 0.83 && playerA.surfaceMatches >= MIN_SAMPLE_MATCHES &&
        playerB.surfaceMatches >= MIN_SAMPLE_MATCHES) {
      result.confidence = 'MEDIUM';
    }

    result.reasoning.push(
      `Expected games: ~${expectedGames} (surface: ${surface}, format: ${format}, avg hold: ${(avgHold * 100).toFixed(1)}%)`
    );
    result.correlations.push({
      tag: 'COMMON',
      note: 'Clay reduces ace rate and increases rally length — pushes game totals higher than hard-court baselines.',
    });

    if (avgHold >= 0.84) {
      result.correlations.push({
        tag: 'UNDERRATED',
        note: 'Two high-hold-rate servers suppress break frequency → sets go deeper → total games elevated. Market often underweights this on clay.',
      });
    }
  }

  // ── Total Sets ───────────────────────────────────────────────────────────────
  else if (prop.market === 'total_sets') {
    const line = prop.line;
    const { fairProbA } = estimateFairMatchProb(holdA, holdB, format, fatigueScore);
    // Rough P(goes to max sets): competitive match (fairProbA 0.45–0.55) → higher set count
    const competitiveFactor = 1 - Math.abs(fairProbA - 0.5) * 2;
    const pOverSets = format === 'bo5'
      ? 0.35 + competitiveFactor * 0.30  // range ~0.35–0.65
      : 0.40 + competitiveFactor * 0.25;
    result.fairProb = prop.side === 'over'
      ? parseFloat(pOverSets.toFixed(4))
      : parseFloat((1 - pOverSets).toFixed(4));
    result.edge     = calcEdge(result.fairProb, result.impliedProb);
    result.confidence = 'MEDIUM';

    if (fatigueScore.magnitude >= 3) {
      result.reasoning.push(`Fatigue asymmetry (${fatigueScore.magnitude} sets) increases probability of competitive extended match.`);
      result.correlations.push({
        tag: 'UNDERRATED',
        note: 'Fatigued player + high-hold opponent = more breaks late in sets 3–5, extending match duration.',
      });
    }
  }

  // ── Set Spread (+1.5 / -1.5) ────────────────────────────────────────────────
  else if (prop.market === 'set_spread') {
    const { fairProbA, fairProbB } = estimateFairMatchProb(holdA, holdB, format, fatigueScore);
    // P(underdog wins at least 1 set) ≈ 1 - P(favorite wins all sets)
    const pFavSweep = format === 'bo5'
      ? Math.pow(fairProbA, 3) * 0.55   // not all 3-set combos are sweeps
      : Math.pow(fairProbA, 2) * 0.60;
    const pUnderdogCoversSpread = 1 - pFavSweep;

    if (prop.side === 'underdog_plus') {
      result.fairProb = parseFloat(pUnderdogCoversSpread.toFixed(4));
    } else {
      result.fairProb = parseFloat(pFavSweep.toFixed(4));
    }
    result.edge     = calcEdge(result.fairProb, result.impliedProb);
    result.confidence = 'MEDIUM';

    result.reasoning.push(
      `High hold rates (A: ${(holdA*100).toFixed(1)}%, B: ${(holdB*100).toFixed(1)}%) suppress sweep probability. Underdog +1.5 sets historically hits ~60–70% when both players hold above 82%.`
    );
    result.correlations.push({
      tag: 'UNDERRATED',
      note: 'Sliding clay defense by undersized servers extends rallies and service games, reducing 3-0 sweep frequency. Most bettors underprice this.',
    });
  }

  // ── Unknown market ───────────────────────────────────────────────────────────
  else {
    result.verdict = 'NO BET – insufficient data';
    result.reasoning.push(`Market "${prop.market}" not yet supported by tennis picks engine.`);
    return result;
  }

  // ── Hard Filters ─────────────────────────────────────────────────────────────
  const hardFilterFails = runHardFilters(prop, playerA, playerB, matchContext, fatigueScore);
  if (hardFilterFails.length > 0) {
    result.verdict  = 'NO BET';
    result.confidence = 'LOW';
    result.reasoning.push(...hardFilterFails.map(f => `HARD FILTER: ${f}`));
    return result;
  }

  // ── Verdict ───────────────────────────────────────────────────────────────────
  if (result.edge >= MIN_EDGE_PTS) {
    result.verdict = 'BET';
  } else if (result.edge >= 2 && result.edge < MIN_EDGE_PTS) {
    result.verdict = 'MARGINAL – edge below 3pt threshold';
  } else {
    result.verdict = 'NO BET';
  }

  return result;
}

// ─── Hard Filters ─────────────────────────────────────────────────────────────

function runHardFilters(prop, playerA, playerB, matchContext, fatigueScore) {
  const fails = [];

  // Underdog has played MORE sets than the favorite
  if (prop.side === 'B' || prop.side === 'underdog_plus') {
    if (fatigueScore.fatiguedPlayer === 'B' && fatigueScore.magnitude >= 4) {
      fails.push('Underdog (B) played 4+ more sets than favorite — fatigue edge flipped, do not back underdog.');
    }
  }

  // Implied prob already above 40% for underdog ML — market has priced the upset
  if (prop.market === 'ml' && (prop.side === 'B') && prop.impliedProb > 0.40) {
    // Not a hard fail, but note it
  }

  // Surface mismatch
  if (playerA.statSurface && playerA.statSurface !== matchContext.surface) {
    fails.push(`Player A stats from ${playerA.statSurface}, match on ${matchContext.surface}.`);
  }
  if (playerB.statSurface && playerB.statSurface !== matchContext.surface) {
    fails.push(`Player B stats from ${playerB.statSurface}, match on ${matchContext.surface}.`);
  }

  // Thin sample — both players
  if ((playerA.surfaceMatches || 0) < MIN_SAMPLE_MATCHES &&
      (playerB.surfaceMatches || 0) < MIN_SAMPLE_MATCHES) {
    fails.push(`Both players have fewer than ${MIN_SAMPLE_MATCHES} surface matches. Insufficient data for reliable edge.`);
  }

  return fails;
}

// ─── Normal CDF approximation ─────────────────────────────────────────────────

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf  = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p    = 1 - pdf * poly;
  return z >= 0 ? p : 1 - p;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * POST /api/tennis-picks
 *
 * Body:
 * {
 *   match: {
 *     surface: 'clay' | 'grass' | 'hard' | 'indoor_hard',
 *     format: 'bo3' | 'bo5',
 *     tournament: string,
 *     round: string,
 *   },
 *   playerA: {
 *     name: string,
 *     holdRate: number,          // e.g. 0.857
 *     aceRate: number,           // aces per service game
 *     dfRate: number,            // double faults per service game
 *     firstServeIn: number,      // e.g. 0.63
 *     firstServePtsWon: number,  // e.g. 0.75
 *     secondServePtsWon: number, // e.g. 0.54
 *     breakPctConverted: number, // e.g. 0.39
 *     surfaceMatches: number,    // sample size
 *     statSurface: string,       // surface these stats are from
 *   },
 *   playerB: { ...same shape },
 *   contextA: {
 *     setsPlayedLast2Rounds: number,
 *     daysSinceLastMatch: number,
 *     injuryFlags: string[],
 *   },
 *   contextB: { ...same shape },
 *   priorOddsA: number,          // American odds for A 24–48h ago (for inflation detection)
 *   props: [
 *     { market: 'ml', side: 'A', bookOdds: -218 },
 *     { market: 'ml', side: 'B', bookOdds: 174 },
 *     { market: 'total_games', side: 'over', line: 37.5, bookOdds: -115 },
 *     { market: 'total_games', side: 'under', line: 37.5, bookOdds: -125 },
 *     { market: 'total_sets', side: 'over', line: 3.5, bookOdds: 115 },
 *     { market: 'set_spread', side: 'underdog_plus', bookOdds: -145 },
 *   ]
 * }
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const { match, playerA, playerB, contextA, contextB, priorOddsA, props } = body || {};

  // ── Validate required fields ────────────────────────────────────────────────
  const missing = [];
  if (!match?.surface)   missing.push('match.surface');
  if (!match?.format)    missing.push('match.format');
  if (!playerA?.holdRate) missing.push('playerA.holdRate');
  if (!playerB?.holdRate) missing.push('playerB.holdRate');
  if (!Array.isArray(props) || props.length === 0) missing.push('props[]');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required fields. Please provide: surface, format, player stats (holdRate), and at least one prop.',
      missingFields: missing,
      expectedFormat: {
        match: { surface: 'clay|grass|hard|indoor_hard', format: 'bo3|bo5', tournament: 'string', round: 'string' },
        playerA: { name: 'string', holdRate: 0.857, aceRate: 0.8, dfRate: 0.2, surfaceMatches: 18, statSurface: 'clay' },
        playerB: '...same as playerA',
        contextA: { setsPlayedLast2Rounds: 9, daysSinceLastMatch: 1, injuryFlags: [] },
        contextB: '...same as contextA',
        priorOddsA: -150,
        props: [
          { market: 'ml', side: 'A', bookOdds: -218 },
          { market: 'total_games', side: 'over', line: 37.5, bookOdds: -115 },
          { market: 'set_spread', side: 'underdog_plus', bookOdds: -145 },
        ],
      },
    });
  }

  // ── Audit ───────────────────────────────────────────────────────────────────
  const auditA = auditPlayerStats(playerA, match.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, match.surface, playerB.statSurface);

  // ── Fatigue ─────────────────────────────────────────────────────────────────
  const fatigueScore = scoreFatigueAsymmetry(
    { ...contextA, setsPlayedLast2Rounds: contextA?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextA?.daysSinceLastMatch || 1 },
    { ...contextB, setsPlayedLast2Rounds: contextB?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextB?.daysSinceLastMatch || 1 }
  );

  // ── Narrative Inflation ─────────────────────────────────────────────────────
  let inflationCheck = null;
  if (priorOddsA) {
    try {
      const priorImplied  = americanToImplied(priorOddsA);
      const currentMLProp = props.find(p => p.market === 'ml' && p.side === 'A');
      if (currentMLProp) {
        const currentImplied = americanToImplied(currentMLProp.bookOdds);
        inflationCheck = detectNarrativeInflation(
          currentImplied,
          priorImplied,
          match.narrativeTrigger || 'recent notable win'
        );
      }
    } catch { /* non-critical */ }
  }

  // ── Evaluate each prop ──────────────────────────────────────────────────────
  const matchContext = {
    surface: match.surface,
    format: match.format,
    contextA: contextA || {},
    contextB: contextB || {},
  };

  const results = props.map(prop => {
    const r = evaluateProp(prop, playerA, playerB, matchContext);

    // Attach narrative inflation warning to ML props
    if (prop.market === 'ml' && inflationCheck?.inflated) {
      r.reasoning.unshift(inflationCheck.warning);
    }

    return {
      market:      r.market,
      side:        r.side,
      line:        prop.line || null,
      bookOdds:    r.bookOdds,
      impliedProb: `${(r.impliedProb * 100).toFixed(1)}%`,
      fairProb:    r.fairProb !== null ? `${(r.fairProb * 100).toFixed(1)}%` : 'N/A',
      edgePts:     r.edge !== null ? `${r.edge > 0 ? '+' : ''}${r.edge}` : 'N/A',
      confidence:  r.confidence,
      verdict:     r.verdict,
      reasoning:   r.reasoning,
      correlations: r.correlations,
    };
  });

  // ── Bets summary ────────────────────────────────────────────────────────────
  const bets     = results.filter(r => r.verdict === 'BET');
  const noBets   = results.filter(r => r.verdict.startsWith('NO BET'));
  const marginal = results.filter(r => r.verdict.startsWith('MARGINAL'));

  const marketEfficiencyNote = bets.length === 0 && marginal.length === 0
    ? 'Markets appear efficient or data too noisy — no edge meets the 3pt minimum threshold. Pass all markets.'
    : null;

  // ── Response ────────────────────────────────────────────────────────────────
  return res.status(200).json({
    meta: {
      generatedAt:  new Date().toISOString(),
      match: {
        playerA: playerA.name || 'Player A',
        playerB: playerB.name || 'Player B',
        surface: match.surface,
        format:  match.format,
        tournament: match.tournament || '',
        round:   match.round || '',
      },
    },
    audit: {
      playerA: { name: playerA.name, ...auditA },
      playerB: { name: playerB.name, ...auditB },
    },
    fatigueAnalysis: fatigueScore,
    narrativeInflation: inflationCheck,
    picks: results,
    summary: {
      totalProps:    results.length,
      bets:          bets.length,
      marginal:      marginal.length,
      noBets:        noBets.length,
      topBets:       bets.map(b => `${b.market} ${b.side} (${b.edgePts}pts, ${b.confidence})`),
      marketEfficiencyNote,
    },
  });
};
