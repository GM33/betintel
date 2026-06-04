// api/_lib/nba-model.js
// BetIntel — NBA Prop + Game Market Model Evaluator
//
// Evaluates every live NBA market and returns structured predictions
// ready for logPrediction() in nba-logger.js.
//
// Markets supported:
//   SPREAD    — line movement + power rating differential
//   TOTAL     — real pace inflation signal (homePace + awayPace vs league avg)
//   MONEYLINE — power rating win probability (logistic from netRtg diff)
//   PROP      — B2B decay + line-move + defensive rating matchup
//
// Signal stack per pick:
//   1. Line-move signal     — opening vs current line delta
//   2. Model edge           — model fair prob - market no-vig prob
//   3. Pace inflation       — combined game pace vs league avg (totals only)
//   4. Power rating         — netRtg differential → win probability (ML/spread)
//   5. Defensive rating     — opponent defRtg vs league avg (props only)
//   6. B2B decay            — 3% under bias on back-to-back nights (props)
//   7. Confidence tier      — LOW / MED / HIGH based on edge + signal count

'use strict';

const { noVig }                                          = require('./no-vig');
const { getTeamStats, LEAGUE_AVG_PACE, LEAGUE_AVG_DEF_RTG } = require('./nba-team-stats');

// ── Constants ────────────────────────────────────────────────────────────────
const HIGH_EDGE_THRESHOLD  = 0.04;  // 4% model edge for HIGH tier
const MED_EDGE_THRESHOLD   = 0.025; // 2.5% for MED tier
const HIGH_MOVE_THRESHOLD  = 0.5;   // points of line movement
const POWER_BLEND          = 0.40;  // weight of model vs market for moneyline (40/60)
const DEF_RTG_CAP          = 0.04;  // max ±4% adjustment from defensive rating signal
const PACE_ADJ_SCALE       = 0.08;  // how strongly pace ratio affects totals edge

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
// Returns ratio of expected game pace vs league average.
// >1.0 = pace-inflated (favors overs), <1.0 = pace-suppressed (favors unders).
// Uses real team pace data from nba-team-stats.js.
// Falls back to neutral 1.0 if either team is unresolved.

function paceInflationSignal(homeTeam, awayTeam) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return 1.0; // graceful fallback
  const combinedPace = (home.pace + away.pace) / 2;
  return combinedPace / LEAGUE_AVG_PACE;
}

// ── Signal: Power Rating (Moneyline / Spread) ─────────────────────────────────
// Derives win probability from net rating differential using logistic scaling.
// k=0.065 calibrated so a 10-pt netRtg gap ≈ 65% win probability.
// Blended 40% model / 60% market to stay conservative until backtested.

function powerRatingSignal(homeTeam, awayTeam) {
  const home = getTeamStats(homeTeam);
  const away = getTeamStats(awayTeam);
  if (!home || !away) return null; // signal absent — caller falls back to noVig
  const netDiff   = (home.netRtg - away.netRtg) + 2.5; // +2.5 home court advantage
  const modelProb = 1 / (1 + Math.exp(-0.065 * netDiff));
  return parseFloat(modelProb.toFixed(4));
}

// ── Signal: Defensive Rating Matchup (Props) ──────────────────────────────────
// Returns a probability delta for player props based on opponent's defensive
// rating vs league average. Weak defenses → positive delta for overs.
// Capped at ±DEF_RTG_CAP (4%) so it cannot single-handedly drive a pick.
//
// marketKey hints at which defensive dimension matters:
//   player_points / player_assists → perimeter defense (defRtg proxy)
//   player_rebounds               → frontcourt defense (same proxy for now)

function defRatingSignal(opponentTeam, isOver) {
  const opp = getTeamStats(opponentTeam);
  if (!opp) return 0;
  // How much weaker/stronger is opponent defense vs league avg?
  // Positive = opponent defRtg > league avg = weaker defense = favors overs
  const defGap  = opp.defRtg - LEAGUE_AVG_DEF_RTG;
  const rawAdj  = defGap * 0.004; // scale: 1 defRtg point ≈ 0.4% prob shift
  const cappedAdj = Math.max(-DEF_RTG_CAP, Math.min(DEF_RTG_CAP, rawAdj));
  return isOver ? cappedAdj : -cappedAdj;
}

// ── Signal: B2B Decay ─────────────────────────────────────────────────────────

function b2bDecayFactor(isB2B) {
  return isB2B ? 0.97 : 1.0;
}

// ── Model: SPREAD ─────────────────────────────────────────────────────────────

function evalSpread(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig  = noVigProb(outcome.price, oppOutcome.price);
  const lineMove     = lineMoveSignal(outcome.point, openLine);
  const sharpBias    = lineMove.isHighMove ? 0.02 : 0;
  // Power rating: if team name matches the outcome, add power signal
  const powerProb    = powerRatingSignal(homeTeam, awayTeam);
  let powerAdj = 0;
  if (powerProb !== null) {
    // outcome.name is the team name for spreads; blend model toward power rating
    const isHome = outcome.name === homeTeam ||
                   (homeTeam && outcome.name && homeTeam.toLowerCase().includes(outcome.name.toLowerCase()));
    const modelSide = isHome ? powerProb : (1 - powerProb);
    powerAdj = (modelSide - marketNoVig) * POWER_BLEND;
  }
  const modelProb  = Math.min(0.95, Math.max(0.05, marketNoVig + sharpBias + powerAdj));
  const modelEdge  = modelProb - marketNoVig;
  return { marketNoVig, modelProb, modelEdge, lineMove, powerProb };
}

// ── Model: TOTAL ──────────────────────────────────────────────────────────────

function evalTotal(outcome, oppOutcome, openLine, homeTeam, awayTeam) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const paceRatio   = paceInflationSignal(homeTeam, awayTeam);
  const isOver      = outcome.name.toLowerCase() === 'over';
  // Pace ratio >1 favors overs; <1 favors unders
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
    // No team data — fall back to pure no-vig (honest zero edge)
    return { marketNoVig, modelProb: marketNoVig, modelEdge: 0, lineMove: { delta: null, isHighMove: false }, powerProb: null };
  }

  const isHome    = outcome.name === homeTeam ||
                    (homeTeam && outcome.name && homeTeam.toLowerCase().includes(outcome.name.toLowerCase()));
  const modelSide = isHome ? powerProb : (1 - powerProb);
  // Blend: 40% model, 60% market
  const blendedProb = (POWER_BLEND * modelSide) + ((1 - POWER_BLEND) * marketNoVig);
  const modelEdge   = blendedProb - marketNoVig;

  return {
    marketNoVig,
    modelProb: parseFloat(Math.min(0.95, Math.max(0.05, blendedProb)).toFixed(4)),
    modelEdge: parseFloat(modelEdge.toFixed(4)),
    lineMove:  { delta: null, isHighMove: false },
    powerProb,
  };
}

// ── Model: PLAYER PROP ────────────────────────────────────────────────────────

function evalProp(outcome, oppOutcome, openLine, isB2B = false, opponentTeam = null) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const decay       = b2bDecayFactor(isB2B);
  const isOver      = outcome.name.toLowerCase().includes('over');
  const decayAdj    = isOver ? (decay - 1) : -(decay - 1);
  const sharpBias   = lineMove.isHighMove ? 0.025 : 0;
  const defAdj      = defRatingSignal(opponentTeam, isOver);
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + decayAdj + sharpBias + defAdj));
  const modelEdge   = modelProb - marketNoVig;
  return { marketNoVig, modelProb, modelEdge, lineMove, decay, defAdj: parseFloat(defAdj.toFixed(4)) };
}

// ── Confidence tier ───────────────────────────────────────────────────────────

function confidenceTier(modelEdge, lineMove, marketType) {
  const absEdge = Math.abs(modelEdge);
  const hasMove = lineMove.isHighMove;
  if (absEdge >= HIGH_EDGE_THRESHOLD && hasMove)  return 'HIGH';
  if (absEdge >= HIGH_EDGE_THRESHOLD || hasMove)  return 'MED';
  if (absEdge >= MED_EDGE_THRESHOLD)               return 'MED';
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

      const pairs = [];
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
          // player_points, player_rebounds, player_assists, etc.
          // opponentTeam: use the team that is NOT the player's team.
          // The Odds API does not tell us which team a player is on,
          // so we default to awayTeam as the opponent (conservative).
          result     = evalProp(a, b, openLine, false, awayTeam);
          marketType = 'PROP';
        }

        const tier = confidenceTier(result.modelEdge, result.lineMove, marketType);

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
          // Extra debug fields (stripped in nba-picks.js if needed)
          paceRatio:      result.paceRatio ?? null,
          powerProb:      result.powerProb ?? null,
          defAdj:         result.defAdj    ?? null,
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
