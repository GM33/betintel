// api/tennis-picks.js
// BetIntel Tennis Picks Engine
// Surface-adjusted prop & line analyzer with edge detection, confidence tiers,
// fatigue asymmetry scoring, narrative inflation detection, and BET/NO BET verdicts.
// Patched June 2026 after algorithm audit.

'use strict';

const MIN_EDGE_PTS = 3;
const MIN_SAMPLE_MATCHES = 12;
const GOOD_SAMPLE_MATCHES = 25;
const NARRATIVE_INFLATION_THRESHOLD = 18;

function americanToImplied(odds) {
  if (typeof odds !== 'number') throw new Error('odds must be a number');
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function impliedToAmerican(prob) {
  if (prob <= 0 || prob >= 1) throw new Error('prob must be between 0 and 1');
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

function calcEdge(fairProb, impliedProb) {
  return parseFloat(((fairProb - impliedProb) * 100).toFixed(2));
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
    flags.push(`BORDERLINE_SAMPLE: ${n} surface matches (good threshold: ${GOOD_SAMPLE_MATCHES})`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }

  if (stats.holdRate > 0.97 || stats.holdRate < 0.55) {
    flags.push(`OUTLIER_RISK: holdRate ${(stats.holdRate * 100).toFixed(1)}% is outside normal range`);
    if (reliability === 'HIGH') reliability = 'MEDIUM';
  }

  return { reliable: reliability !== 'LOW', reliability, flags, sampleSize: n };
}

function scoreFatigueAsymmetry(contextA, contextB) {
  const diff = (contextA.setsPlayedLast2Rounds || 0) - (contextB.setsPlayedLast2Rounds || 0);
  const restDiff = (contextB.daysSinceLastMatch || 1) - (contextA.daysSinceLastMatch || 1);

  let fatiguedPlayer = 'EVEN';
  let magnitude = 0;
  let edgeNote = 'No significant fatigue asymmetry detected.';

  if (diff >= 4) {
    fatiguedPlayer = 'A';
    magnitude = diff;
    edgeNote = `Player A played ${diff} more sets in last 2 rounds — significant conditioning disadvantage. Underdog ML likely underpriced by 4–8 pts.`;
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
  } else if (restDiff <= -2) {
    edgeNote += ` Player B also has ${Math.abs(restDiff)} fewer rest days.`;
  }

  return { fatiguedPlayer, setDiff: diff, restDiff, magnitude, edgeNote };
}

function detectNarrativeInflation(currentImplied, priorImplied, triggerEvent) {
  const shiftPts = parseFloat(((currentImplied - priorImplied) * 100).toFixed(2));
  const inflated = shiftPts >= NARRATIVE_INFLATION_THRESHOLD;

  return {
    inflated,
    shiftPts,
    warning: inflated
      ? `NARRATIVE_INFLATION: Line shifted +${shiftPts}pts after "${triggerEvent}". Favorite likely overpriced.`
      : `Line shift of ${shiftPts}pts after "${triggerEvent}" — within normal range.`,
  };
}

function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

function raceToNMatchProb(pSet, n) {
  let prob = 0;
  for (let losses = 0; losses < n; losses++) {
    prob += binomialCoeff(n - 1 + losses, losses) * Math.pow(pSet, n) * Math.pow(1 - pSet, losses);
  }
  return prob;
}

function expectedSetsPlayed(pSet, n) {
  let expected = 0;
  if (n === 3) {
    const p30 = Math.pow(pSet, 3);
    const p31 = 3 * Math.pow(pSet, 3) * (1 - pSet);
    const p32 = 6 * Math.pow(pSet, 3) * Math.pow(1 - pSet, 2);
    const p03 = Math.pow(1 - pSet, 3);
    const p13 = 3 * Math.pow(1 - pSet, 3) * pSet;
    const p23 = 6 * Math.pow(1 - pSet, 3) * Math.pow(pSet, 2);
    expected = 3 * (p30 + p03) + 4 * (p31 + p13) + 5 * (p32 + p23);
  } else {
    const p20 = Math.pow(pSet, 2);
    const p21 = 2 * Math.pow(pSet, 2) * (1 - pSet);
    const p02 = Math.pow(1 - pSet, 2);
    const p12 = 2 * Math.pow(1 - pSet, 2) * pSet;
    expected = 2 * (p20 + p02) + 3 * (p21 + p12);
  }
  return expected;
}

function estimateSetWinProb(holdA, holdB) {
  const numerator = holdA * (1 - holdB);
  const denominator = numerator + (1 - holdA) * holdB;
  if (denominator === 0) return 0.5;
  return Math.min(0.97, Math.max(0.03, numerator / denominator));
}

function estimateFairMatchProb(holdA, holdB, format = 'bo3', fatigueScore = {}) {
  let adjHoldA = holdA;
  let adjHoldB = holdB;

  if (fatigueScore.fatiguedPlayer === 'A') adjHoldA = holdA - (fatigueScore.magnitude * 0.008);
  else if (fatigueScore.fatiguedPlayer === 'B') adjHoldB = holdB - (fatigueScore.magnitude * 0.008);

  adjHoldA = Math.min(0.98, Math.max(0.50, adjHoldA));
  adjHoldB = Math.min(0.98, Math.max(0.50, adjHoldB));

  const pAWinsSet = estimateSetWinProb(adjHoldA, adjHoldB);
  const setsToWin = format === 'bo5' ? 3 : 2;
  const pAWinsMatch = raceToNMatchProb(pAWinsSet, setsToWin);

  return {
    fairProbA: parseFloat(Math.min(0.97, Math.max(0.03, pAWinsMatch)).toFixed(4)),
    fairProbB: parseFloat((1 - pAWinsMatch).toFixed(4)),
    pAWinsSet: parseFloat(pAWinsSet.toFixed(4)),
    adjHoldA: parseFloat(adjHoldA.toFixed(4)),
    adjHoldB: parseFloat(adjHoldB.toFixed(4)),
  };
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p = 1 - pdf * poly;
  return z >= 0 ? p : 1 - p;
}

function runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, impliedProb) {
  const fails = [];

  if ((prop.side === 'B' || prop.side === 'underdog_plus') && fatigueScore.fatiguedPlayer === 'B' && fatigueScore.magnitude >= 4) {
    fails.push('Underdog (B) played 4+ more sets than favorite — fatigue edge flipped.');
  }

  if (prop.market === 'ml' && prop.side === 'B' && impliedProb > 0.40) {
    fails.push('Underdog ML implied probability already above 40% — upset likely priced in.');
  }

  if (playerA.statSurface && playerA.statSurface !== matchContext.surface) fails.push(`Player A stats from ${playerA.statSurface}, match on ${matchContext.surface}.`);
  if (playerB.statSurface && playerB.statSurface !== matchContext.surface) fails.push(`Player B stats from ${playerB.statSurface}, match on ${matchContext.surface}.`);

  if ((playerA.surfaceMatches || 0) < MIN_SAMPLE_MATCHES && (playerB.surfaceMatches || 0) < MIN_SAMPLE_MATCHES) {
    fails.push(`Both players have fewer than ${MIN_SAMPLE_MATCHES} surface matches. Insufficient data for reliable edge.`);
  }

  return fails;
}

function evaluateProp(prop, playerA, playerB, matchContext) {
  const { surface, format } = matchContext;
  const fatigueScore = scoreFatigueAsymmetry(matchContext.contextA || {}, matchContext.contextB || {});
  const holdA = playerA.holdRate || 0.82;
  const holdB = playerB.holdRate || 0.82;
  const fair = estimateFairMatchProb(holdA, holdB, format, fatigueScore);
  const avgHold = (fair.adjHoldA + fair.adjHoldB) / 2;
  const avgSets = expectedSetsPlayed(fair.pAWinsSet, format === 'bo5' ? 3 : 2);
  const surfaceGameFactor = surface === 'clay' ? 10.2 : surface === 'grass' ? 9.4 : 9.8;
  const holdGameBonus = (avgHold - 0.82) * 40;
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

  if (prop.market === 'ml') {
    result.fairProb = prop.side === 'A' ? fair.fairProbA : fair.fairProbB;
    result.edge = calcEdge(result.fairProb, result.impliedProb);

    const auditA = auditPlayerStats(playerA, surface, playerA.statSurface);
    const auditB = auditPlayerStats(playerB, surface, playerB.statSurface);
    if (auditA.reliability === 'HIGH' && auditB.reliability === 'HIGH') result.confidence = 'HIGH';
    else if (auditA.reliability !== 'LOW' && auditB.reliability !== 'LOW') result.confidence = 'MEDIUM';

    if (fatigueScore.magnitude >= 4) {
      result.reasoning.push(fatigueScore.edgeNote);
      result.correlations.push({ tag: 'UNDERRATED', note: 'Fatigue asymmetry of 4+ sets in BO5 increases late-match serve degradation.' });
    }
  } else if (prop.market === 'total_games') {
    const line = prop.line;
    const sd = format === 'bo5' ? 3.5 : 2.5;
    const z = (line - expectedGames) / sd;
    const pUnder = normalCDF(z);
    result.fairProb = prop.side === 'over' ? parseFloat((1 - pUnder).toFixed(4)) : parseFloat(pUnder.toFixed(4));
    result.edge = calcEdge(result.fairProb, result.impliedProb);
    if (avgHold >= 0.83 && playerA.surfaceMatches >= MIN_SAMPLE_MATCHES && playerB.surfaceMatches >= MIN_SAMPLE_MATCHES) result.confidence = 'MEDIUM';
    result.reasoning.push(`Expected games: ~${expectedGames} (surface: ${surface}, avg sets: ${avgSets.toFixed(2)}, avg hold: ${(avgHold * 100).toFixed(1)}%)`);
    result.correlations.push({ tag: 'COMMON', note: 'Clay reduces ace rate and increases rally length — pushes game totals higher than hard-court baselines.' });
    if (avgHold >= 0.84) result.correlations.push({ tag: 'UNDERRATED', note: 'Two high-hold-rate servers suppress break frequency and deepen sets.' });
  } else if (prop.market === 'total_sets') {
    const line = prop.line;
    const p3 = format === 'bo5' ? (Math.pow(fair.pAWinsSet, 3) + Math.pow(1 - fair.pAWinsSet, 3)) : (Math.pow(fair.pAWinsSet, 2) + Math.pow(1 - fair.pAWinsSet, 2));
    let pOver;
    if (format === 'bo5') {
      const p4 = 3 * Math.pow(fair.pAWinsSet, 3) * (1 - fair.pAWinsSet) + 3 * Math.pow(1 - fair.pAWinsSet, 3) * fair.pAWinsSet;
      const p5 = 6 * Math.pow(fair.pAWinsSet, 3) * Math.pow(1 - fair.pAWinsSet, 2) + 6 * Math.pow(1 - fair.pAWinsSet, 3) * Math.pow(fair.pAWinsSet, 2);
      if (line === 3.5) pOver = p4 + p5;
      else if (line === 4.5) pOver = p5;
      else pOver = avgSets > line ? 0.55 : 0.45;
    } else {
      const p3sets = 2 * Math.pow(fair.pAWinsSet, 2) * (1 - fair.pAWinsSet) + 2 * Math.pow(1 - fair.pAWinsSet, 2) * fair.pAWinsSet;
      if (line === 2.5) pOver = p3sets;
      else pOver = avgSets > line ? 0.55 : 0.45;
    }
    result.fairProb = prop.side === 'over' ? parseFloat(pOver.toFixed(4)) : parseFloat((1 - pOver).toFixed(4));
    result.edge = calcEdge(result.fairProb, result.impliedProb);
    result.confidence = 'MEDIUM';
    if (fatigueScore.magnitude >= 3) {
      result.reasoning.push(`Fatigue asymmetry (${fatigueScore.magnitude} sets) increases extended-match probability.`);
      result.correlations.push({ tag: 'UNDERRATED', note: 'Fatigued player + high-hold opponent = more breaks late in sets 3–5, extending match duration.' });
    }
  } else if (prop.market === 'set_spread') {
    const pFavSweep = format === 'bo5' ? Math.pow(fair.pAWinsSet, 3) : Math.pow(fair.pAWinsSet, 2);
    const pDogSweep = format === 'bo5' ? Math.pow(1 - fair.pAWinsSet, 3) : Math.pow(1 - fair.pAWinsSet, 2);
    const pUnderdogPlus = 1 - pFavSweep;
    const pFavoriteMinus = pFavSweep;
    result.fairProb = prop.side === 'underdog_plus' ? parseFloat(pUnderdogPlus.toFixed(4)) : parseFloat(pFavoriteMinus.toFixed(4));
    result.edge = calcEdge(result.fairProb, result.impliedProb);
    result.confidence = 'MEDIUM';
    result.reasoning.push(`Sweep probability modeled directly from set-win probability (${(fair.pAWinsSet * 100).toFixed(1)}%).`);
    result.correlations.push({ tag: 'UNDERRATED', note: 'High hold rates reduce sweep probability and improve +1.5 set cover rates.' });
  } else {
    result.verdict = 'NO BET – insufficient data';
    result.reasoning.push(`Market "${prop.market}" not yet supported by tennis picks engine.`);
    return result;
  }

  const hardFilterFails = runHardFilters(prop, playerA, playerB, matchContext, fatigueScore, result.impliedProb);
  if (hardFilterFails.length > 0) {
    result.verdict = 'NO BET';
    result.confidence = 'LOW';
    result.reasoning.push(...hardFilterFails.map(f => `HARD FILTER: ${f}`));
    return result;
  }

  if (result.edge >= MIN_EDGE_PTS) result.verdict = 'BET';
  else if (result.edge >= 2) result.verdict = 'MARGINAL – edge below 3pt threshold';
  else result.verdict = 'NO BET';

  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const { match, playerA, playerB, contextA, contextB, priorOddsA, props } = body || {};
  const missing = [];
  if (!match?.surface) missing.push('match.surface');
  if (!match?.format) missing.push('match.format');
  if (!playerA?.holdRate) missing.push('playerA.holdRate');
  if (!playerB?.holdRate) missing.push('playerB.holdRate');
  if (!Array.isArray(props) || props.length === 0) missing.push('props[]');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required fields. Please provide: surface, format, player stats (holdRate), and at least one prop.',
      missingFields: missing,
    });
  }

  const auditA = auditPlayerStats(playerA, match.surface, playerA.statSurface);
  const auditB = auditPlayerStats(playerB, match.surface, playerB.statSurface);
  const fatigueScore = scoreFatigueAsymmetry(
    { ...contextA, setsPlayedLast2Rounds: contextA?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextA?.daysSinceLastMatch || 1 },
    { ...contextB, setsPlayedLast2Rounds: contextB?.setsPlayedLast2Rounds || 0, daysSinceLastMatch: contextB?.daysSinceLastMatch || 1 }
  );

  let inflationCheck = null;
  if (priorOddsA) {
    try {
      const priorImplied = americanToImplied(priorOddsA);
      const currentMLProp = props.find(p => p.market === 'ml' && p.side === 'A');
      if (currentMLProp) {
        inflationCheck = detectNarrativeInflation(americanToImplied(currentMLProp.bookOdds), priorImplied, match.narrativeTrigger || 'recent notable win');
      }
    } catch {}
  }

  const matchContext = { surface: match.surface, format: match.format, contextA: contextA || {}, contextB: contextB || {} };

  const results = props.map(prop => {
    const r = evaluateProp(prop, playerA, playerB, matchContext);
    if (prop.market === 'ml' && inflationCheck?.inflated) r.reasoning.unshift(inflationCheck.warning);
    return {
      market: r.market,
      side: r.side,
      line: prop.line || null,
      bookOdds: r.bookOdds,
      impliedProb: `${(r.impliedProb * 100).toFixed(1)}%`,
      fairProb: r.fairProb !== null ? `${(r.fairProb * 100).toFixed(1)}%` : 'N/A',
      edgePts: r.edge !== null ? `${r.edge > 0 ? '+' : ''}${r.edge}` : 'N/A',
      confidence: r.confidence,
      verdict: r.verdict,
      reasoning: r.reasoning,
      correlations: r.correlations,
    };
  });

  const bets = results.filter(r => r.verdict === 'BET');
  const noBets = results.filter(r => r.verdict.startsWith('NO BET'));
  const marginal = results.filter(r => r.verdict.startsWith('MARGINAL'));
  const marketEfficiencyNote = bets.length === 0 && marginal.length === 0
    ? 'Markets appear efficient or data too noisy — no edge meets the 3pt minimum threshold. Pass all markets.'
    : null;

  return res.status(200).json({
    meta: {
      generatedAt: new Date().toISOString(),
      match: {
        playerA: playerA.name || 'Player A',
        playerB: playerB.name || 'Player B',
        surface: match.surface,
        format: match.format,
        tournament: match.tournament || '',
        round: match.round || '',
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
      totalProps: results.length,
      bets: bets.length,
      marginal: marginal.length,
      noBets: noBets.length,
      topBets: bets.map(b => `${b.market} ${b.side} (${b.edgePts}pts, ${b.confidence})`),
      marketEfficiencyNote,
    },
  });
};
