// api/_lib/wnba-model.js
// BetIntel — WNBA Prop + Game Market Model Evaluator
//
// Mirrors nba-model.js with WNBA-specific constants:
//   - League avg pace: 83.20 (40-min game, fewer possessions than NBA)
//   - Home court advantage: 1.5 pts (smaller than NBA's 2.5)
//   - B2B decay: 2% (WNBA schedule less condensed than NBA)
//   - Logistic k: 0.07 (slightly steeper — WNBA netRtg gaps are larger)
//
// Markets supported:
//   SPREAD    — line movement + power rating
//   TOTAL     — real pace inflation signal
//   MONEYLINE — power rating logistic from netRtg diff
//   PROP      — B2B decay + line-move + defensive rating matchup

'use strict';

const { noVig }                                               = require('./no-vig');
const { getTeamStats, LEAGUE_AVG_PACE, LEAGUE_AVG_DEF_RTG }  = require('./wnba-team-stats');
const { getOpponentTeam }                                     = require('./wnba-rosters');

// ── WNBA-specific constants ───────────────────────────────────────────────────────
const HIGH_EDGE_THRESHOLD  = 0.04;
const MED_EDGE_THRESHOLD   = 0.025;
const HIGH_MOVE_THRESHOLD  = 0.5;
const POWER_BLEND          = 0.40;
const DEF_RTG_CAP          = 0.04;
const PACE_ADJ_SCALE       = 0.08;
const HOME_COURT_ADJ       = 1.5;  // WNBA home court (vs NBA 2.5)
const LOGISTIC_K           = 0.07; // steeper curve for WNBA netRtg gaps
const B2B_DECAY            = 0.98; // 2% under bias (vs NBA 3%)

// ── Probability helpers ───────────────────────────────────────────────────────

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

// ── Signal: Line Move ─────────────────────────────────────────────────────────

function lineMoveSignal(currentLine, openLine) {
  if (openLine == null || currentLine == null) return { delta: null, isHighMove: false };
  const delta = Math.abs(currentLine - openLine);
  return { delta: parseFloat(delta.toFixed(2)), isHighMove: delta >= HIGH_MOVE_THRESHOLD };
}

// ── Signal: Pace Inflation ────────────────────────────────────────────────────

function paceInflationSignal(homeTeam, awayTeam) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return 1.0;
  const combinedPace = (home.pace + away.pace) / 2;
  return combinedPace / LEAGUE_AVG_PACE;
}

// ── Signal: Power Rating ──────────────────────────────────────────────────────
// WNBA home court: 1.5 pts (vs NBA 2.5). Logistic k=0.07.

function powerRatingSignal(homeTeam, awayTeam) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return null;
  const netDiff   = (home.netRtg - away.netRtg) + HOME_COURT_ADJ;
  const modelProb = 1 / (1 + Math.exp(-LOGISTIC_K * netDiff));
  return parseFloat(modelProb.toFixed(4));
}

// ── Signal: Defensive Rating Matchup ─────────────────────────────────────────

function defRatingSignal(opponentTeam, isOver) {
  const opp = getTeamStats(opponentTeam);
  if (!opp) return 0;
  const defGap    = opp.defRtg - LEAGUE_AVG_DEF_RTG;
  const rawAdj    = defGap * 0.004;
  const cappedAdj = Math.max(-DEF_RTG_CAP, Math.min(DEF_RTG_CAP, rawAdj));
  return isOver ? cappedAdj : -cappedAdj;
}

// ── Signal: B2B Decay ─────────────────────────────────────────────────────────

function b2bDecayFactor(isB2B) {
  return isB2B ? B2B_DECAY : 1.0;
}

// ── Model: SPREAD ─────────────────────────────────────────────────────────────

function evalSpread(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const sharpBias   = lineMove.isHighMove ? 0.02 : 0;
  const powerProb   = powerRatingSignal(homeTeam, awayTeam);
  let powerAdj = 0;
  if (powerProb !== null) {
    const isHome    = homeTeam && outcome.name &&
                      homeTeam.toLowerCase().includes(outcome.name.toLowerCase().split(' ').pop());
    const modelSide = isHome ? powerProb : (1 - powerProb);
    powerAdj = (modelSide - marketNoVig) * POWER_BLEND;
  }
  const modelProb = Math.min(0.95, Math.max(0.05, marketNoVig + sharpBias + powerAdj));
  const modelEdge = modelProb - marketNoVig;
  return { marketNoVig, modelProb, modelEdge, lineMove, powerProb };
}

// ── Model: TOTAL ──────────────────────────────────────────────────────────────

function evalTotal(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const paceRatio   = paceInflationSignal(homeTeam, awayTeam);
  const isOver      = outcome.name.toLowerCase() === 'over';
  const paceAdj     = isOver ? (paceRatio - 1) * PACE_ADJ_SCALE : -(paceRatio - 1) * PACE_ADJ_SCALE;
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + paceAdj));
  const modelEdge   = modelProb - marketNoVig;
  return { marketNoVig, modelProb, modelEdge, lineMove, paceRatio: parseFloat(paceRatio.toFixed(4)) };
}

// ── Model: MONEYLINE ──────────────────────────────────────────────────────────

function evalMoneyline(outcome, oppOutcome, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const powerProb   = powerRatingSignal(homeTeam, awayTeam);
  if (powerProb === null) {
    return { marketNoVig, modelProb: marketNoVig, modelEdge: 0, lineMove: { delta: null, isHighMove: false }, powerProb: null };
  }
  const isHome      = homeTeam && outcome.name &&
                      homeTeam.toLowerCase().includes(outcome.name.toLowerCase().split(' ').pop());
  const modelSide   = isHome ? powerProb : (1 - powerProb);
  const blendedProb = (POWER_BLEND * modelSide) + ((1 - POWER_BLEND) * marketNoVig);
  const modelEdge   = blendedProb - marketNoVig;
  return {
    marketNoVig,
    modelProb:  parseFloat(Math.min(0.95, Math.max(0.05, blendedProb)).toFixed(4)),
    modelEdge:  parseFloat(modelEdge.toFixed(4)),
    lineMove:   { delta: null, isHighMove: false },
    powerProb,
  };
}

// ── Model: PLAYER PROP ────────────────────────────────────────────────────────

function evalProp(outcome, oppOutcome, openLine, isB2B = false, homeTeam = null, awayTeam = null) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const decay       = b2bDecayFactor(isB2B);
  const isOver      = outcome.name.toLowerCase().includes('over');
  const decayAdj    = isOver ? (decay - 1) : -(decay - 1);
  const sharpBias   = lineMove.isHighMove ? 0.025 : 0;
  const playerName  = outcome.description || null;
  const resolvedOpp = playerName
    ? (getOpponentTeam(playerName, homeTeam, awayTeam) || awayTeam)
    : awayTeam;
  const defAdj    = defRatingSignal(resolvedOpp, isOver);
  const modelProb = Math.min(0.95, Math.max(0.05, marketNoVig + decayAdj + sharpBias + defAdj));
  const modelEdge = modelProb - marketNoVig;
  return { marketNoVig, modelProb, modelEdge, lineMove, decay, defAdj: parseFloat(defAdj.toFixed(4)), resolvedOpp };
}

// ── Confidence tier ───────────────────────────────────────────────────────────

function confidenceTier(modelEdge, lineMove) {
  const absEdge = Math.abs(modelEdge);
  const hasMove = lineMove.isHighMove;
  if (absEdge >= HIGH_EDGE_THRESHOLD && hasMove) return 'HIGH';
  if (absEdge >= HIGH_EDGE_THRESHOLD || hasMove) return 'MED';
  if (absEdge >= MED_EDGE_THRESHOLD)              return 'MED';
  return 'LOW';
}

// ── Main evaluator ─────────────────────────────────────────────────────────────

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

        if (mkt.key === 'h2h') {
          result     = evalMoneyline(a, b, homeTeam, awayTeam);
          marketType = 'MONEYLINE';
        } else if (mkt.key === 'spreads') {
          result     = evalSpread(a, b, openLine, homeTeam, awayTeam);
          marketType = 'SPREAD';
        } else if (mkt.key === 'totals') {
          result     = evalTotal(a, b, openLine, homeTeam, awayTeam);
          marketType = 'TOTAL';
        } else {
          result     = evalProp(a, b, openLine, false, homeTeam, awayTeam);
          marketType = 'PROP';
        }

        const tier = confidenceTier(result.modelEdge, result.lineMove);

        predictions.push({
          gameId:         event.id,
          homeTeam,
          awayTeam,
          commenceTime:   event.commence_time,
          book:           book.key,
          marketType,
          marketKey:      mkt.key,
          selection:      a.description ? `${a.description} ${a.name}` : a.name,
          line:           a.point ?? null,
          priceAtEval:    a.price,
          modelProb:      parseFloat(result.modelProb.toFixed(4)),
          modelEdge:      parseFloat(result.modelEdge.toFixed(4)),
          confidenceTier: tier,
          lineDelta:      result.lineMove.delta,
          isHighMove:     result.lineMove.isHighMove,
          paceRatio:      result.paceRatio   ?? null,
          powerProb:      result.powerProb   ?? null,
          defAdj:         result.defAdj      ?? null,
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
  for (const ev of (events || [])) {
    const preds = evaluateEvent(ev, openLines[ev.id] || {});
    all.push(...preds);
  }
  return all;
}

module.exports = { evaluateEvent, evaluateAll, confidenceTier, lineMoveSignal, paceInflationSignal, powerRatingSignal, defRatingSignal };
