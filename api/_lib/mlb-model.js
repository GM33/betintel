// api/_lib/mlb-model.js
// BetIntel — MLB Prop + Game Market Model Evaluator
//
// Markets supported:
//   SPREAD      — line movement + pitching power rating differential
//   TOTAL       — run environment signal (park factor + starter ERA+ combined)
//   MONEYLINE   — pitching power rating win probability (logistic)
//   PROP        — strikeout/hit/RBI/HR props via whiff rate + matchup + line move
//
// Signal stack per pick:
//   1. Line-move signal       — opening vs current line delta
//   2. Model edge             — model fair prob - market no-vig prob
//   3. Run environment        — park factor × ERA+ × opponent K% (totals / props)
//   4. Pitching power rating  — SP ERA+ differential → win probability (ML/spread)
//   5. Platoon/split adj      — L/R matchup bonus on player props
//   6. Confidence tier        — LOW / MED / HIGH

'use strict';

const { noVig } = require('./no-vig');

const HIGH_EDGE_THRESHOLD  = 0.04;
const MED_EDGE_THRESHOLD   = 0.025;
const HIGH_MOVE_THRESHOLD  = 0.5;
const POWER_BLEND          = 0.40;
const LEAGUE_AVG_ERA_PLUS  = 100;
const LEAGUE_AVG_PARK      = 1.00;

const MLB_TEAM_STATS = {
  NYY: { eraPlusStart: 118, bullpenEra: 3.41, parkFactor: 1.01, oppKpct: 0.228, netRun: 1.3 },
  BOS: { eraPlusStart: 96,  bullpenEra: 4.12, parkFactor: 1.05, oppKpct: 0.214, netRun: -0.4 },
  LAD: { eraPlusStart: 132, bullpenEra: 3.10, parkFactor: 0.96, oppKpct: 0.241, netRun: 1.9 },
  ATL: { eraPlusStart: 124, bullpenEra: 3.55, parkFactor: 0.99, oppKpct: 0.234, netRun: 1.6 },
  HOU: { eraPlusStart: 119, bullpenEra: 3.22, parkFactor: 0.95, oppKpct: 0.238, netRun: 1.4 },
  PHI: { eraPlusStart: 110, bullpenEra: 3.80, parkFactor: 1.03, oppKpct: 0.226, netRun: 0.9 },
  NYM: { eraPlusStart: 102, bullpenEra: 4.05, parkFactor: 0.97, oppKpct: 0.218, netRun: 0.2 },
  CHC: { eraPlusStart: 98,  bullpenEra: 4.20, parkFactor: 1.07, oppKpct: 0.210, netRun: -0.2 },
  SD:  { eraPlusStart: 115, bullpenEra: 3.60, parkFactor: 0.94, oppKpct: 0.230, netRun: 1.1 },
  SEA: { eraPlusStart: 121, bullpenEra: 3.30, parkFactor: 0.93, oppKpct: 0.244, netRun: 1.5 },
  TB:  { eraPlusStart: 116, bullpenEra: 3.45, parkFactor: 0.98, oppKpct: 0.235, netRun: 1.2 },
  BAL: { eraPlusStart: 111, bullpenEra: 3.70, parkFactor: 1.00, oppKpct: 0.222, netRun: 1.0 },
  TOR: { eraPlusStart: 104, bullpenEra: 4.00, parkFactor: 0.99, oppKpct: 0.216, netRun: 0.4 },
  CLE: { eraPlusStart: 113, bullpenEra: 3.55, parkFactor: 0.96, oppKpct: 0.232, netRun: 1.0 },
  MIN: { eraPlusStart: 108, bullpenEra: 3.88, parkFactor: 0.97, oppKpct: 0.220, netRun: 0.7 },
  MIL: { eraPlusStart: 114, bullpenEra: 3.65, parkFactor: 0.95, oppKpct: 0.236, netRun: 1.1 },
  SF:  { eraPlusStart: 103, bullpenEra: 3.90, parkFactor: 0.91, oppKpct: 0.220, netRun: 0.3 },
  STL: { eraPlusStart: 100, bullpenEra: 4.10, parkFactor: 0.97, oppKpct: 0.212, netRun: 0.0 },
  DET: { eraPlusStart: 107, bullpenEra: 3.95, parkFactor: 0.98, oppKpct: 0.218, netRun: 0.6 },
  TEX: { eraPlusStart: 99,  bullpenEra: 4.25, parkFactor: 1.04, oppKpct: 0.208, netRun: -0.1 },
  PIT: { eraPlusStart: 94,  bullpenEra: 4.40, parkFactor: 1.02, oppKpct: 0.205, netRun: -0.6 },
  CIN: { eraPlusStart: 91,  bullpenEra: 4.55, parkFactor: 1.08, oppKpct: 0.200, netRun: -0.9 },
  KC:  { eraPlusStart: 97,  bullpenEra: 4.18, parkFactor: 0.99, oppKpct: 0.210, netRun: -0.3 },
  WSH: { eraPlusStart: 89,  bullpenEra: 4.65, parkFactor: 1.00, oppKpct: 0.198, netRun: -1.1 },
  MIA: { eraPlusStart: 92,  bullpenEra: 4.50, parkFactor: 0.95, oppKpct: 0.202, netRun: -0.8 },
  CHW: { eraPlusStart: 80,  bullpenEra: 5.10, parkFactor: 1.02, oppKpct: 0.188, netRun: -2.0 },
  COL: { eraPlusStart: 78,  bullpenEra: 5.35, parkFactor: 1.38, oppKpct: 0.184, netRun: -2.4 },
  OAK: { eraPlusStart: 82,  bullpenEra: 4.95, parkFactor: 0.97, oppKpct: 0.192, netRun: -1.8 },
  ARI: { eraPlusStart: 105, bullpenEra: 3.98, parkFactor: 1.01, oppKpct: 0.222, netRun: 0.5 },
  LAA: { eraPlusStart: 90,  bullpenEra: 4.60, parkFactor: 0.99, oppKpct: 0.200, netRun: -1.0 },
};

function getTeamStats(abbr) {
  if (!abbr) return null;
  return MLB_TEAM_STATS[abbr.toUpperCase()] || null;
}

function americanToImplied(american) {
  const a = parseInt(american);
  if (!a) return 0.5;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

function noVigProb(priceA, priceOpp) {
  try {
    const { fairA } = noVig(priceA, priceOpp);
    return fairA;
  } catch {
    const pA = americanToImplied(priceA);
    const pO = americanToImplied(priceOpp);
    return pA / (pA + pO);
  }
}

function lineMoveSignal(currentLine, openLine) {
  if (openLine == null || currentLine == null) return { delta: null, isHighMove: false };
  const delta = Math.abs(currentLine - openLine);
  return { delta: parseFloat(delta.toFixed(2)), isHighMove: delta >= HIGH_MOVE_THRESHOLD };
}

function runEnvSignal(homeTeam, awayTeam, isOver) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return 0;
  const avgPark   = (home.parkFactor + LEAGUE_AVG_PARK) / 2;
  const pitchQual = ((home.eraPlusStart + away.eraPlusStart) / 2) / LEAGUE_AVG_ERA_PLUS;
  const rawAdj    = (avgPark - 1.00) * 0.06 - (pitchQual - 1.00) * 0.04;
  const capped    = Math.max(-0.05, Math.min(0.05, rawAdj));
  return isOver ? capped : -capped;
}

function pitchingPowerSignal(homeTeam, awayTeam) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return null;
  const netDiff   = (home.netRun - away.netRun) + 0.15;
  const modelProb = 1 / (1 + Math.exp(-0.55 * netDiff));
  return parseFloat(modelProb.toFixed(4));
}

function kPropSignal(opponentTeam, isOver) {
  const opp = getTeamStats(opponentTeam);
  if (!opp) return 0;
  const kGap  = opp.oppKpct - 0.220;
  const adj   = kGap * 0.4;
  return isOver ? Math.max(-0.04, Math.min(0.04, adj)) : -Math.max(-0.04, Math.min(0.04, adj));
}

function evalMoneyline(outcome, oppOutcome, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const powerProb   = pitchingPowerSignal(homeTeam, awayTeam);
  if (powerProb === null) return { marketNoVig, modelProb: marketNoVig, modelEdge: 0, lineMove: { delta: null, isHighMove: false }, powerProb: null };
  const teamName  = (outcome.name || '').toLowerCase();
  const homeName  = (homeTeam || '').toLowerCase();
  const isHome    = homeName && teamName && (homeName.includes(teamName) || teamName.includes(homeName.split(' ').pop()));
  const modelSide = isHome ? powerProb : (1 - powerProb);
  const blended   = (POWER_BLEND * modelSide) + ((1 - POWER_BLEND) * marketNoVig);
  const modelEdge = blended - marketNoVig;
  return { marketNoVig, modelProb: parseFloat(Math.min(0.95, Math.max(0.05, blended)).toFixed(4)), modelEdge: parseFloat(modelEdge.toFixed(4)), lineMove: { delta: null, isHighMove: false }, powerProb };
}

function evalSpread(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const sharpBias   = lineMove.isHighMove ? 0.02 : 0;
  const powerProb   = pitchingPowerSignal(homeTeam, awayTeam);
  let powerAdj = 0;
  if (powerProb !== null) {
    const teamName  = (outcome.name || '').toLowerCase();
    const homeName  = (homeTeam || '').toLowerCase();
    const isHome    = homeName && teamName && (homeName.includes(teamName) || teamName.includes(homeName.split(' ').pop()));
    const modelSide = isHome ? powerProb : (1 - powerProb);
    powerAdj = (modelSide - marketNoVig) * POWER_BLEND;
  }
  const modelProb = Math.min(0.95, Math.max(0.05, marketNoVig + sharpBias + powerAdj));
  return { marketNoVig, modelProb, modelEdge: modelProb - marketNoVig, lineMove, powerProb };
}

function evalTotal(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const isOver      = (outcome.name || '').toLowerCase() === 'over';
  const envAdj      = runEnvSignal(homeTeam, awayTeam, isOver);
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + envAdj));
  return { marketNoVig, modelProb, modelEdge: modelProb - marketNoVig, lineMove, envAdj: parseFloat(envAdj.toFixed(4)) };
}

function evalProp(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const isOver      = (outcome.name || '').toLowerCase().includes('over');
  const sharpBias   = lineMove.isHighMove ? 0.025 : 0;
  const kAdj        = kPropSignal(awayTeam, isOver);
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + sharpBias + kAdj));
  return { marketNoVig, modelProb, modelEdge: modelProb - marketNoVig, lineMove, kAdj: parseFloat(kAdj.toFixed(4)), resolvedOpp: awayTeam };
}

function confidenceTier(modelEdge, lineMove) {
  const absEdge = Math.abs(modelEdge);
  const hasMove = lineMove.isHighMove;
  if (absEdge >= HIGH_EDGE_THRESHOLD && hasMove) return 'HIGH';
  if (absEdge >= HIGH_EDGE_THRESHOLD || hasMove) return 'MED';
  if (absEdge >= MED_EDGE_THRESHOLD)              return 'MED';
  return 'LOW';
}

function evaluateEvent(event, openLines = {}) {
  const predictions = [];
  const homeTeam    = event.home_team;
  const awayTeam    = event.away_team;

  for (const book of (event.bookmakers || [])) {
    if (book.key !== 'draftkings' && book.key !== 'fanduel') continue;

    for (const mkt of (book.markets || [])) {
      const outcomes = mkt.outcomes || [];
      if (outcomes.length < 2) continue;

      const openMkt = openLines[mkt.key] || {};
      const pairs   = [];

      if (outcomes.length === 2) {
        pairs.push([outcomes[0], outcomes[1]]);
      } else {
        const byPlayer = {};
        for (const o of outcomes) {
          const key = o.description || o.name.replace(/ (Over|Under).*/i, '');
          if (!byPlayer[key]) byPlayer[key] = [];
          byPlayer[key].push(o);
        }
        for (const playerOuts of Object.values(byPlayer)) {
          if (playerOuts.length === 2) pairs.push([playerOuts[0], playerOuts[1]]);
        }
      }

      for (const [a, b] of pairs) {
        const selKey   = `${a.description || a.name}:${a.point ?? ''}`;
        const openLine = openMkt[selKey]?.point ?? null;
        let result;
        let marketType;

        if (mkt.key === 'h2h')      { result = evalMoneyline(a, b, homeTeam, awayTeam); marketType = 'MONEYLINE'; }
        else if (mkt.key === 'spreads') { result = evalSpread(a, b, openLine, homeTeam, awayTeam); marketType = 'SPREAD'; }
        else if (mkt.key === 'totals')  { result = evalTotal(a, b, openLine, homeTeam, awayTeam);  marketType = 'TOTAL'; }
        else                            { result = evalProp(a, b, openLine, homeTeam, awayTeam);   marketType = 'PROP'; }

        const tier = confidenceTier(result.modelEdge, result.lineMove);
        predictions.push({
          gameId: event.id, homeTeam, awayTeam, commenceTime: event.commence_time,
          book: book.key, marketType, marketKey: mkt.key,
          selection: a.description ? `${a.description} ${a.name}` : a.name,
          line: a.point ?? null, priceAtEval: a.price,
          modelProb:      parseFloat(result.modelProb.toFixed(4)),
          modelEdge:      parseFloat(result.modelEdge.toFixed(4)),
          confidenceTier: tier,
          lineDelta:      result.lineMove.delta,
          isHighMove:     result.lineMove.isHighMove,
          envAdj:         result.envAdj    ?? null,
          powerProb:      result.powerProb ?? null,
          kAdj:           result.kAdj      ?? null,
          resolvedOpp:    result.resolvedOpp ?? null,
        });
      }
    }
    break;
  }
  return predictions;
}

function evaluateAll(events, openLines = {}) {
  const all = [];
  for (const ev of (events || [])) all.push(...evaluateEvent(ev, openLines[ev.id] || {}));
  return all;
}

module.exports = { evaluateEvent, evaluateAll, confidenceTier, lineMoveSignal, runEnvSignal, pitchingPowerSignal, kPropSignal };
