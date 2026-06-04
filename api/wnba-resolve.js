// api/wnba-resolve.js
// BetIntel — WNBA Nightly Results Resolver
//
// Called by Railway cron after WNBA games finish.
// Endpoint: POST /api/wnba-resolve
// Body:     { date: 'YYYY-MM-DD' }  (defaults to yesterday)
// Auth:     x-betintel-cron-secret header
//
// Uses BallDontLie v1 WNBA endpoints:
//   GET /wnba/v1/games?dates[]=YYYY-MM-DD
//   GET /wnba/v1/stats?game_ids[]=<id>

'use strict';

const {
  fetchPendingPredictionIds,
  resolvePrediction,
  getOpenClose,
  fetchPredictions,
} = require('./_lib/nba-logger');

const BDL_BASE            = 'https://api.balldontlie.io';
const BDL_KEY             = process.env.BDL_API_KEY || null;
const HIGH_MOVE_THRESHOLD = 0.5;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bdlFetch(path, attempt = 0) {
  const headers = {};
  if (BDL_KEY) headers['Authorization'] = BDL_KEY;
  const res = await fetch(`${BDL_BASE}${path}`, { headers });
  if (res.status === 429 && attempt === 0) {
    await sleep(2000);
    return bdlFetch(path, 1);
  }
  if (!res.ok) throw new Error(`BDL ${path} → HTTP ${res.status}`);
  return res.json();
}

async function fetchGamesForDate(date) {
  const data = await bdlFetch(`/wnba/v1/games?dates[]=${date}&per_page=20`);
  return data.data || [];
}

async function fetchBoxscore(gameId) {
  const data = await bdlFetch(`/wnba/v1/stats?game_ids[]=${gameId}&per_page=50`);
  const byPlayer = {};
  for (const s of (data.data || [])) {
    const name = `${s.player.first_name} ${s.player.last_name}`;
    byPlayer[s.player.id] = {
      playerId:   s.player.id,
      playerName: name,
      pts:        s.pts,
      reb:        s.reb,
      ast:        s.ast,
      pra:        (s.pts || 0) + (s.reb || 0) + (s.ast || 0),
      min:        s.min,
    };
  }
  return byPlayer;
}

function americanToDecimal(american) {
  const a = parseInt(american);
  if (!a) return 1.909;
  return a > 0 ? (a / 100) + 1 : (100 / Math.abs(a)) + 1;
}

function didBeatCLV(pred, closingPrice) {
  if (!closingPrice || !pred.priceAtEval) return false;
  return americanToDecimal(closingPrice) < americanToDecimal(pred.priceAtEval);
}

function computeOutcome(pred, game, boxscore) {
  const sel  = (pred.selection || '').toLowerCase();
  const line = pred.line != null ? parseFloat(pred.line) : null;

  if (pred.marketType === 'SPREAD') {
    if (!game.home_team_score || !game.visitor_team_score) return null;
    const margin = game.home_team_score - game.visitor_team_score;
    const cover  = sel === 'home' ? margin + line : -margin + line;
    if (cover > 0) return 'WIN';
    if (cover < 0) return 'LOSE';
    return 'PUSH';
  }

  if (pred.marketType === 'TOTAL') {
    if (!game.home_team_score || !game.visitor_team_score || line === null) return null;
    const total = game.home_team_score + game.visitor_team_score;
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
    const isOver  = sel.includes('over');
    const isUnder = sel.includes('under');
    if ((!isOver && !isUnder) || line === null) return null;
    const playerName = pred.selection.replace(/ (OVER|UNDER).*/i, '').trim().toLowerCase();
    const playerStat = Object.values(boxscore).find(s =>
      s.playerName.toLowerCase().includes(playerName)
    );
    if (!playerStat) return null;
    const mk = (pred.marketKey || '').toLowerCase();
    let statValue =
      mk.includes('point')   ? playerStat.pts :
      mk.includes('rebound') ? playerStat.reb :
      mk.includes('assist')  ? playerStat.ast :
      (mk.includes('pra') || mk.includes('pts_reb_ast')) ? playerStat.pra : null;
    if (statValue == null) return null;
    if (isOver)  return statValue > line ? 'WIN' : statValue < line ? 'LOSE' : 'PUSH';
    if (isUnder) return statValue < line ? 'WIN' : statValue > line ? 'LOSE' : 'PUSH';
  }

  return null;
}

function computePnl(outcome, closingPrice) {
  if (outcome === 'PUSH') return 0;
  const decimal = americanToDecimal(closingPrice || -110);
  if (outcome === 'WIN')  return parseFloat((decimal - 1).toFixed(4));
  if (outcome === 'LOSE') return -1;
  return 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-betintel-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const date = req.body?.date || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const pendingIds = await fetchPendingPredictionIds();
    if (!pendingIds.length) {
      return res.status(200).json({ resolved: 0, message: 'No pending predictions' });
    }

    const allPreds = await fetchPredictions(1000, false);
    const pending  = allPreds.filter(p => pendingIds.includes(p.predId));

    const games   = await fetchGamesForDate(date);
    const gameMap = Object.fromEntries(games.map(g => [String(g.id), g]));

    let resolved = 0;
    const errors = [];

    for (const pred of pending) {
      try {
        let game = gameMap[String(pred.gameId)];
        if (!game) {
          game = games.find(g =>
            g.home_team.full_name    === pred.homeTeam ||
            g.visitor_team.full_name === pred.awayTeam
          );
        }
        if (!game || !game.home_team_score) continue;

        let boxscore = {};
        if (pred.marketType === 'PROP') {
          boxscore = await fetchBoxscore(game.id);
          await sleep(400);
        }

        const outcome = computeOutcome(pred, game, boxscore);
        if (!outcome) continue;

        const selKey       = `${pred.selection}:${pred.line ?? ''}`;
        const oc           = await getOpenClose(pred.gameId, pred.marketKey, selKey, pred.book);
        const closingPrice = oc?.close?.price ?? null;
        const openLine     = oc?.open?.point  ?? null;
        const closeLine    = oc?.close?.point ?? null;
        const delta        = (openLine != null && closeLine != null) ? Math.abs(closeLine - openLine) : null;
        const isHighMove   = delta != null && delta >= HIGH_MOVE_THRESHOLD;
        const clvBeaten    = didBeatCLV(pred, closingPrice);
        const pnl          = computePnl(outcome, closingPrice);

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
      pending: pending.length,
      errors:  errors.length ? errors : undefined,
    });

  } catch (err) {
    console.error('[wnba-resolve] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
