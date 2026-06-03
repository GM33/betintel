// api/_lib/nba-model.js
// BetIntel — NBA Prop + Game Market Model Evaluator
//
// Evaluates every live NBA market and returns structured predictions
// ready for logPrediction() in nba-logger.js.
//
// Markets supported:
//   SPREAD    — h2h line movement
//   TOTAL     — game totals
//   MONEYLINE — head-to-head
//   PROP      — player_points, player_rebounds, player_assists, player_points_rebounds_assists
//
// Signal stack per pick:
//   1. Line-move signal    — opening vs current line delta
//   2. Model edge          — model fair prob - market no-vig prob
//   3. Confidence tier     — LOW / MED / HIGH based on edge + signal count
//
// This is the foundation. As you build more signals (pace, rotations,
// ref index etc.) add them as signal modules below and increase tier thresholds.

'use strict';

const { noVig } = require('./no-vig');

// ── Constants ────────────────────────────────────────────────────────────────
const HIGH_EDGE_THRESHOLD = 0.04;  // 4% model edge for HIGH tier
const MED_EDGE_THRESHOLD  = 0.025; // 2.5% for MED tier
const HIGH_MOVE_THRESHOLD = 0.5;   // points of line movement

// ── Probability helpers ───────────────────────────────────────────────────────

function americanToImplied(american) {
  const a = parseInt(american);
  if (!a) return 0.5;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

// No-vig probability for a two-outcome market
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
// Returns the magnitude of line movement (open → current) for a given market.
// openLine comes from the first snapshot stored in nba-logger; if unavailable,
// we pass null and the signal is absent.

function lineMoveSignal(currentLine, openLine) {
  if (openLine == null || currentLine == null) return { delta: null, isHighMove: false };
  const delta = Math.abs(currentLine - openLine);
  return { delta: parseFloat(delta.toFixed(2)), isHighMove: delta >= HIGH_MOVE_THRESHOLD };
}

// ── Signal: Pace Inflation ────────────────────────────────────────────────────
// Placeholder — returns a neutral float until you wire in real pace data.
// Replace with: actualPace / leagueAvgPace for each team.

function paceInflationSignal(/* homeTeam, awayTeam */) {
  return 1.0; // neutral; >1.05 = pace-inflated, <0.95 = pace-suppressed
}

// ── Signal: B2B Decay ─────────────────────────────────────────────────────────
// Returns a probability adjustment factor for back-to-back games.
// isB2B should be derived from schedule data (not yet wired — returns neutral).

function b2bDecayFactor(isB2B) {
  return isB2B ? 0.97 : 1.0; // 3% decay on player props in B2B
}

// ── Model: SPREAD ─────────────────────────────────────────────────────────────
// Fair prob for a spread side based on market no-vig + pace adjustment.
// Currently wraps no-vig as the baseline; wire in power ratings for improvement.

function evalSpread(outcome, oppOutcome, openLine) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  // Baseline: trust the no-vig market, add small edge if sharp money moved it
  const sharpBias   = lineMove.isHighMove ? 0.02 : 0;
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + sharpBias));
  const modelEdge   = modelProb - marketNoVig;

  return { marketNoVig, modelProb, modelEdge, lineMove };
}

// ── Model: TOTAL ──────────────────────────────────────────────────────────────
// Fair prob for over/under based on market no-vig + pace inflation signal.

function evalTotal(outcome, oppOutcome, openLine) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const pace        = paceInflationSignal();
  const paceAdj     = outcome.name.toLowerCase() === 'over' ? (pace - 1) * 0.06 : -(pace - 1) * 0.06;
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + paceAdj));
  const modelEdge   = modelProb - marketNoVig;

  return { marketNoVig, modelProb, modelEdge, lineMove };
}

// ── Model: MONEYLINE ──────────────────────────────────────────────────────────

function evalMoneyline(outcome, oppOutcome) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  // Moneyline: no additional signal yet — model = market no-vig
  return { marketNoVig, modelProb: marketNoVig, modelEdge: 0, lineMove: { delta: null, isHighMove: false } };
}

// ── Model: PLAYER PROP ────────────────────────────────────────────────────────
// Fair prob for over/under using market no-vig + B2B decay + line-move signal.

function evalProp(outcome, oppOutcome, openLine, isB2B = false) {
  const marketNoVig = noVigProb(outcome.price, oppOutcome.price);
  const lineMove    = lineMoveSignal(outcome.point, openLine);
  const decay       = b2bDecayFactor(isB2B);
  const isOver      = outcome.name.toLowerCase().includes('over');
  // B2B decay slightly favors unders
  const decayAdj    = isOver ? (decay - 1) : -(decay - 1);
  const sharpBias   = lineMove.isHighMove ? 0.025 : 0;
  const modelProb   = Math.min(0.95, Math.max(0.05, marketNoVig + decayAdj + sharpBias));
  const modelEdge   = modelProb - marketNoVig;

  return { marketNoVig, modelProb, modelEdge, lineMove, decay };
}

// ── Confidence tier ───────────────────────────────────────────────────────────

function confidenceTier(modelEdge, lineMove, marketType) {
  const absEdge  = Math.abs(modelEdge);
  const hasMove  = lineMove.isHighMove;
  if (absEdge >= HIGH_EDGE_THRESHOLD && hasMove)  return 'HIGH';
  if (absEdge >= HIGH_EDGE_THRESHOLD || hasMove)  return 'MED';
  if (absEdge >= MED_EDGE_THRESHOLD)               return 'MED';
  return 'LOW';
}

// ── Main evaluator ─────────────────────────────────────────────────────────────
// Input: a single normalizeEvents() event object + optional openLines map
//
// openLines shape:
// {
//   [marketKey]: {
//     [selectionKey]: { point: number, price: number }
//   }
// }
//
// Returns array of prediction objects ready for logPrediction()

function evaluateEvent(event, openLines = {}) {
  const predictions = [];

  for (const book of (event.bookmakers || [])) {
    // Prefer DraftKings; fall back to FanDuel
    if (book.key !== 'draftkings' && book.key !== 'fanduel') continue;

    for (const mkt of (book.markets || [])) {
      const outcomes = mkt.outcomes || [];
      if (outcomes.length < 2) continue;

      const openMkt = openLines[mkt.key] || {};

      // Pair outcomes: [over, under] or [home, away]
      const pairs = [];
      if (outcomes.length === 2) {
        pairs.push([outcomes[0], outcomes[1]]);
      } else {
        // For player props with multiple players, group by player name
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
        const selKey  = `${a.description || a.name}:${a.point ?? ''}`;
        const openLine = openMkt[selKey]?.point ?? null;

        let result;
        let marketType;

        if (mkt.key === 'h2h') {
          result = evalMoneyline(a, b);
          marketType = 'MONEYLINE';
        } else if (mkt.key === 'spreads') {
          result = evalSpread(a, b, openLine);
          marketType = 'SPREAD';
        } else if (mkt.key === 'totals') {
          result = evalTotal(a, b, openLine);
          marketType = 'TOTAL';
        } else {
          // player_points, player_rebounds, player_assists, player_points_rebounds_assists, etc.
          result = evalProp(a, b, openLine);
          marketType = 'PROP';
        }

        const tier = confidenceTier(result.modelEdge, result.lineMove, marketType);

        predictions.push({
          gameId:         event.id,
          homeTeam:       event.home_team,
          awayTeam:       event.away_team,
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
        });
      }
    }

    break; // Only process first eligible book per event
  }

  return predictions;
}

/**
 * Evaluate all events in a live odds response.
 * @param {Array}  events    - normalizeEvents() output
 * @param {object} openLines - map of gameId → marketKey → selectionKey → { point, price }
 * @returns {Array} flat list of prediction objects
 */
function evaluateAll(events, openLines = {}) {
  const all = [];
  for (const ev of (events || [])) {
    const preds = evaluateEvent(ev, openLines[ev.id] || {});
    all.push(...preds);
  }
  return all;
}

module.exports = { evaluateEvent, evaluateAll, confidenceTier, lineMoveSignal };
