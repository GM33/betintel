// api/mlb-picks.js
// BetIntel — Live MLB Picks Endpoint
// GET /api/mlb-picks?tier=HIGH|MED|LOW&markets=h2h,spreads,totals,pitcher_strikeouts,...

'use strict';

const { fetchOdds, sanitizeMarkets, normalizeEvents } = require('./_lib/odds');
const { evaluateAll }    = require('./_lib/mlb-model');
const { logPrediction, getOpenClose } = require('./_lib/mlb-logger');

const DEFAULT_MARKETS = 'h2h,spreads,totals,batter_home_runs,batter_hits,batter_rbis,pitcher_strikeouts,pitcher_outs';
const SPORT           = 'baseball_mlb';
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
          if (oc?.open) openLines[ev.id][mkt.key][selKey] = { point: oc.open.point, price: oc.open.price };
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
      regions: 'us', markets, oddsFormat: 'american', dateFormat: 'iso',
    }, { retries: 1, timeoutMs: 5000 });

    if (!result.ok) return res.status(502).json({ error: 'Odds provider unavailable', code: result.errorCode });

    const events = normalizeEvents(result.data, 'american');
    if (!events.length) return res.status(200).json({ picks: [], message: 'No MLB games found for today', sport: SPORT, quota: result.quota });

    const openLines = await buildOpenLines(events);
    const allPreds  = evaluateAll(events, openLines);

    if (logPicks) {
      const toLog = allPreds.filter(p => p.confidenceTier !== 'LOW');
      Promise.all(toLog.map(p => logPrediction(p))).catch(err => console.warn('[mlb-picks] log error:', err.message));
    }

    let picks = allPreds;
    if (tierFilter) picks = picks.filter(p => p.confidenceTier === tierFilter);
    picks = picks.filter(p => Math.abs(p.modelEdge) > 0.01).sort((a, b) => Math.abs(b.modelEdge) - Math.abs(a.modelEdge));

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
      verdict:      p.confidenceTier === 'HIGH' ? 'BET' : p.confidenceTier === 'MED' ? 'WATCH' : 'PASS',
    }));

    return res.status(200).json({
      generatedAt:  new Date().toISOString(),
      slateDate:    new Date().toISOString().slice(0, 10),
      sport:        SPORT,
      modelVersion: 'mlb-v1',
      picks:        response,
      total:        response.length,
      highConf:     response.filter(p => p.confidence === 'HIGH').length,
      quota:        result.quota,
    });

  } catch (err) {
    console.error('[mlb-picks] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
