// api/nba-resolve.js
// BetIntel — NBA Nightly Results Resolver
//
// Called by a Railway cron (or a POST from your CI) after games finish.
// For every pending NBA prediction:
//   1. Fetches final boxscore / player stats from BallDontLie v2
//   2. Fetches closing line from nba-logger snapshot history
//   3. Marks isHighMove, resultOutcome, resultValue, clvBeaten
//
// Endpoint: POST /api/nba-resolve
// Body:     { date: 'YYYY-MM-DD' }   (defaults to yesterday)
// Auth:     x-betintel-cron-secret header must match CRON_SECRET env var

'use strict';

const {
  fetchPendingPredictionIds,
  resolvePrediction,
  getOpenClose,
  fetchPredictions,
} = require('./_lib/nba-logger');

const BDL_BASE  = 'https://api.balldontlie.io/v1';
const BDL_KEY   = process.env.BDL_API_KEY || '';
const HIGH_MOVE_THRESHOLD = 0.5;

// ── BallDontLie helpers ──────────────────────────────────────────────────────

async function bdlFetch(path) {
  const res = await fetch(`${BDL_BASE}${path}`, {
    headers: { Authorization: BDL_KEY },
  });
  if (!res.ok) throw new Error(`BDL ${path} → ${res.status}`);
  return res.json();
}

// Returns array of game objects for a given date string 'YYYY-MM-DD'
async function fetchGamesForDate(date) {
  const data = await bdlFetch(`/games?dates[]=${date}&per_page=30`);
  return data.data || [];
}

// Returns final boxscore stats keyed by player_id for a specific game
async function fetchBoxscore(gameId) {
  const data = await bdlFetch(`/stats?game_ids[]=${gameId}&per_page=100`);
  const byPlayer = {};
  for (const s of (data.data || [])) {
    byPlayer[s.player.id] = {
      playerId:   s.player.id,
      playerName: `${s.player.first_name} ${s.player.last_name}`,
      pts:        s.pts,
      reb:        s.reb,
      ast:        s.ast,
      pra:        (s.pts || 0) + (s.reb || 0) + (s.ast || 0),
      min:        s.min,
    };
  }
  return byPlayer;
}

// ── Decimal odds conversion ──────────────────────────────────────────────────
function americanToDecimal(american) {
  const a = parseInt(american);
  return a > 0 ? (a / 100) + 1 : (100 / Math.abs(a)) + 1;
}

// No-vig implied probability for a two-outcome market
// Pass both sides' American odds to remove vig
function noVigProb(americanSide, americanOpp) {
  const pSide = americanSide > 0 ? 100 / (americanSide + 100) : Math.abs(americanSide) / (Math.abs(americanSide) + 100);
  const pOpp  = americanOpp  > 0 ? 100 / (americanOpp  + 100) : Math.abs(americanOpp)  / (Math.abs(americanOpp)  + 100);
  const total = pSide + pOpp;
  return pSide / total;
}

// ── CLV check ────────────────────────────────────────────────────────────────
// Returns true if model implied fair line beat closing line (you had the sharp side)
function didBeatCLV(pred, closingPrice) {
  if (!closingPrice || !pred.priceAtEval || !pred.modelProb) return false;
  // Model fair probability implied by modelProb
  // If model was OVER/HOME and closing price got WORSE for that side → model was right early
  const evalDecimal    = americanToDecimal(pred.priceAtEval);
  const closingDecimal = americanToDecimal(closingPrice);
  // A worse price at close means market moved against you = you had CLV
  return closingDecimal < evalDecimal;
}

// ── Outcome computation ──────────────────────────────────────────────────────
// Returns 'WIN' | 'LOSE' | 'PUSH' | null
function computeOutcome(pred, game, boxscore) {
  const sel = (pred.selection || '').toLowerCase();
  const line = pred.line != null ? parseFloat(pred.line) : null;

  if (pred.marketType === 'SPREAD') {
    // Spread: home margin = home_score - away_score
    if (!game.home_team_score || !game.visitor_team_score) return null;
    const margin = game.home_team_score - game.visitor_team_score;
    if (sel === 'home') {
      if (line === null) return null;
      const cover = margin + line; // e.g. home -3.5: need margin > 3.5
      if (cover > 0) return 'WIN';
      if (cover < 0) return 'LOSE';
      return 'PUSH';
    } else {
      const cover = -margin + line; // away +3.5
      if (cover > 0) return 'WIN';
      if (cover < 0) return 'LOSE';
      return 'PUSH';
    }
  }

  if (pred.marketType === 'TOTAL') {
    if (!game.home_team_score || !game.visitor_team_score) return null;
    const total = game.home_team_score + game.visitor_team_score;
    if (line === null) return null;
    if (sel === 'over')  return total > line ? 'WIN' : total < line ? 'LOSE' : 'PUSH';
    if (sel === 'under') return total < line ? 'WIN' : total > line ? 'LOSE' : 'PUSH';
  }

  if (pred.marketType === 'MONEYLINE') {
    if (!game.home_team_score || !game.visitor_team_score) return null;
    const homeWon = game.home_team_score > game.visitor_team_score;
    if (sel === 'home') return homeWon ? 'WIN' : 'LOSE';
    if (sel === 'away') return !homeWon ? 'WIN' : 'LOSE';
  }

  if (pred.marketType === 'PROP') {
    // selection format: "Player Name OVER|UNDER"
    // Find the player in the boxscore by name match
    const isOver = sel.includes('over');
    const isUnder = sel.includes('under');
    if (!isOver && !isUnder) return null;
    if (line === null) return null;

    const playerName = pred.selection.replace(/ (OVER|UNDER).*/i, '').trim().toLowerCase();
    const playerStat = Object.values(boxscore).find(s =>
      s.playerName.toLowerCase().includes(playerName)
    );
    if (!playerStat) return null;

    const mk = (pred.marketKey || '').toLowerCase();
    let statValue = null;
    if (mk.includes('point')) statValue = playerStat.pts;
    else if (mk.includes('rebound')) statValue = playerStat.reb;
    else if (mk.includes('assist')) statValue = playerStat.ast;
    else if (mk.includes('pra') || mk.includes('pts_reb_ast')) statValue = playerStat.pra;
    if (statValue == null) return null;

    if (isOver)  return statValue > line ? 'WIN' : statValue < line ? 'LOSE' : 'PUSH';
    if (isUnder) return statValue < line ? 'WIN' : statValue > line ? 'LOSE' : 'PUSH';
  }

  return null;
}

// ── P&L calculation (flat 1 unit at -110 default) ────────────────────────────
function computePnl(outcome, closingPrice) {
  if (outcome === 'PUSH') return 0;
  const decimal = closingPrice ? americanToDecimal(closingPrice) : americanToDecimal(-110);
  if (outcome === 'WIN')  return parseFloat((decimal - 1).toFixed(4));
  if (outcome === 'LOSE') return -1;
  return 0;
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-betintel-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!BDL_KEY) return res.status(500).json({ error: 'BDL_API_KEY not configured' });

  const date = req.body?.date || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    // 1. Fetch all pending prediction IDs
    const pendingIds = await fetchPendingPredictionIds();
    if (!pendingIds.length) return res.status(200).json({ resolved: 0, message: 'No pending predictions' });

    // 2. Fetch all pending predictions as objects
    const allPreds = await fetchPredictions(1000, false);
    const pending  = allPreds.filter(p => pendingIds.includes(p.predId));

    // 3. Fetch BDL games for this date
    const games = await fetchGamesForDate(date);
    const gameMap = {};
    for (const g of games) {
      // BDL game id → use as lookup; also match by team name
      gameMap[g.id] = g;
    }

    // 4. Resolve each pending prediction
    let resolved = 0;
    const errors = [];

    for (const pred of pending) {
      try {
        // Match prediction to a BDL game by gameId or by home/away team name
        let game = gameMap[pred.gameId];
        if (!game) {
          // Fallback: match by team names stored in nba:game:{gameId}
          game = games.find(g =>
            g.home_team.full_name === pred.homeTeam ||
            g.visitor_team.full_name === pred.awayTeam
          );
        }
        if (!game || !game.home_team_score) continue; // game not finished

        // 5. Get boxscore stats for props
        let boxscore = {};
        if (pred.marketType === 'PROP') {
          boxscore = await fetchBoxscore(game.id);
        }

        // 6. Compute outcome
        const outcome = computeOutcome(pred, game, boxscore);
        if (!outcome) continue;

        // 7. Get closing line from snapshot history
        const selKey = `${pred.selection}:${pred.line ?? ''}`;
        const oc = await getOpenClose(pred.gameId, pred.marketKey, selKey, pred.book);
        const closingPrice = oc?.close?.price ?? null;
        const openLine     = oc?.open?.point  ?? null;
        const closeLine    = oc?.close?.point ?? null;

        // 8. Compute flags
        const delta      = (openLine != null && closeLine != null) ? Math.abs(closeLine - openLine) : null;
        const isHighMove = delta != null && delta >= HIGH_MOVE_THRESHOLD;
        const clvBeaten  = didBeatCLV(pred, closingPrice);
        const pnl        = computePnl(outcome, closingPrice);

        // 9. Persist resolution
        await resolvePrediction(pred.predId, {
          closingLine:   closeLine,
          closingPrice,
          isHighMove:    isHighMove ? '1' : '0',
          resultOutcome: outcome,
          resultValue:   pnl,
          clvBeaten:     clvBeaten ? '1' : '0',
        });

        resolved++;
      } catch (err) {
        errors.push({ predId: pred.predId, error: err.message });
      }
    }

    return res.status(200).json({
      date,
      resolved,
      errors: errors.length ? errors : undefined,
    });

  } catch (err) {
    console.error('[nba-resolve] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
