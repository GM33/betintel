// api/wnba-picks.js
// BetIntel — WNBA Picks Endpoint
//
// GET /api/wnba-picks?tier=HIGH|MED|LOW&markets=spreads,totals,player_points
//
// Flow:
//   1. Fetch live WNBA odds from The Odds API (sport: basketball_wnba)
//   2. Retrieve opening lines from Redis snapshot history
//   3. Run wnba-model evaluateAll() over every market
//   4. Log each prediction via nba-logger.logPrediction() (reuses NBA logger)
//   5. Return filtered, sorted predictions

'use strict';

const { fetchOdds, sanitizeMarkets, normalizeEvents } = require('./_lib/odds');
const { evaluateAll }    = require('./_lib/wnba-model');
const { logPrediction, getOpenClose } = require('./_lib/nba-logger');

const DEFAULT_MARKETS = 'h2h,spreads,totals,player_points,player_rebounds,player_assists';
const SPORT           = 'basketball_wnba';
const PRIMARY_BOOK    = 'draftkings';

async function buildOpenLines(events) {
  const openLines = {};
  for (const ev of events) {
    openLines[ev.id] = {};
    for (const book of (ev.bookmakers || [])) {
      if (book.key !== PRIMARY_BOOK) continue;
      for (const mkt of (book.markets || [])) {
        openLines[ev.id][mkt.key] = openLines[ev.id][mkt.key] || {};
        for (const o of (mkt.outcomes || [])) {
          const selKey = `${o.description || o.name}:${o.point ?? ''}`;
          const oc = await getOpenClose(ev.id, mkt.key, selKey, PRIMARY_BOOK);
          if (oc?.open) {
            openLines[ev.id][mkt.key][selKey] = { point: oc.open.point, price: oc.open.price };
          }
        }
      }
    }
  }
  return openLines;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const tierFilter   = (req.query.tier || '').toUpperCase();
  const marketsParam = req.query.markets || DEFAULT_MARKETS;
  const markets      = sanitizeMarkets(marketsParam);
  const logPicks     = req.query.log !== 'false';

  try {
    const result = await fetchOdds(`/sports/${SPORT}/odds`, {
      regions:    'us',
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
    }, { retries: 1, timeoutMs: 4000 });

    if (!result.ok) {
      return res.status(502).json({ error: 'Odds provider unavailable', code: result.errorCode });
    }

    const events = normalizeEvents(result.data, 'american');
    if (!events.length) {
      return res.status(200).json({ picks: [], message: 'No WNBA games found', quota: result.quota });
    }

    const openLines = await buildOpenLines(events);
    const allPreds  = evaluateAll(events, openLines);

    if (logPicks) {
      const toLog = allPreds.filter(p => p.confidenceTier !== 'LOW');
      Promise.all(toLog.map(p => logPrediction(p))).catch(err =>
        console.warn('[wnba-picks] log error:', err.message)
      );
    }

    let picks = allPreds;
    if (tierFilter) picks = picks.filter(p => p.confidenceTier === tierFilter);
    picks = picks
      .filter(p => Math.abs(p.modelEdge) > 0.01)
      .sort((a, b) => Math.abs(b.modelEdge) - Math.abs(a.modelEdge));

    const response = picks.map(p => ({
      game:         `${p.awayTeam} @ ${p.homeTeam}`,
      commenceTime: p.commenceTime,
      market:       p.marketType,
      marketKey:    p.marketKey,
      selection:    p.selection,
      line:         p.line,
      priceAtEval:  p.priceAtEval,
      modelProb:    `${(p.modelProb * 100).toFixed(1)}%`,
      modelEdge:    `${p.modelEdge > 0 ? '+' : ''}${(p.modelEdge * 100).toFixed(2)}%`,
      confidence:   p.confidenceTier,
      lineDelta:    p.lineDelta,
      isHighMove:   p.isHighMove,
      verdict:      p.confidenceTier === 'HIGH' ? 'BET'
                  : p.confidenceTier === 'MED'  ? 'WATCH'
                  : 'PASS',
    }));

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      sport:       SPORT,
      picks:       response,
      total:       response.length,
      highConf:    response.filter(p => p.confidence === 'HIGH').length,
      quota:       result.quota,
    });

  } catch (err) {
    console.error('[wnba-picks] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
