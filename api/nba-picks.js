// api/nba-picks.js
// BetIntel — NBA Picks Endpoint
//
// GET /api/nba-picks?tier=HIGH|MED|LOW&markets=spreads,totals,player_points
//
// Flow:
//   1. Fetch live NBA odds from The Odds API (reuses existing fetchOdds)
//   2. Retrieve opening lines from Redis snapshot history
//   3. Run nba-model evaluateAll() over every market
//   4. Log each prediction via nba-logger.logPrediction()
//   5. Return filtered, sorted predictions to the caller
//
// This is the NBA equivalent of api/tennis-picks.js.
// Wire the frontend "NBA" tab to this endpoint.

'use strict';

const { fetchOdds, sanitizeMarkets, normalizeEvents } = require('./_lib/odds');
const { evaluateAll }    = require('./_lib/nba-model');
const { logPrediction, getOpenClose } = require('./_lib/nba-logger');

const DEFAULT_MARKETS = 'h2h,spreads,totals,player_points,player_rebounds,player_assists';
const SPORT           = 'basketball_nba';
const PRIMARY_BOOK    = 'draftkings';

// Rebuild the openLines map for an event from Redis snapshots
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

  const tierFilter    = (req.query.tier || '').toUpperCase();   // 'HIGH'|'MED'|'LOW'|''
  const marketsParam  = req.query.markets || DEFAULT_MARKETS;
  const markets       = sanitizeMarkets(marketsParam);
  const logPicks      = req.query.log !== 'false'; // default: log predictions

  try {
    // 1. Fetch live NBA odds
    const result = await fetchOdds(`/sports/${SPORT}/odds`, {
      regions: 'us',
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
    }, { retries: 1, timeoutMs: 4000 });

    if (!result.ok) {
      return res.status(502).json({ error: 'Odds provider unavailable', code: result.errorCode });
    }

    const events = normalizeEvents(result.data, 'american');
    if (!events.length) {
      return res.status(200).json({ picks: [], message: 'No NBA games found', quota: result.quota });
    }

    // 2. Build open-line map from Redis snapshots
    const openLines = await buildOpenLines(events);

    // 3. Run the model over all events
    const allPreds = evaluateAll(events, openLines);

    // 4. Log HIGH + MED predictions to Redis (fire-and-forget)
    if (logPicks) {
      const toLog = allPreds.filter(p => p.confidenceTier !== 'LOW');
      Promise.all(toLog.map(p => logPrediction(p))).catch(err =>
        console.warn('[nba-picks] log error:', err.message)
      );
    }

    // 5. Filter + sort for response
    let picks = allPreds;
    if (tierFilter) picks = picks.filter(p => p.confidenceTier === tierFilter);
    picks = picks
      .filter(p => Math.abs(p.modelEdge) > 0.01) // drop near-zero edge noise
      .sort((a, b) => Math.abs(b.modelEdge) - Math.abs(a.modelEdge));

    // 6. Shape response
    const response = picks.map(p => ({
      game:           `${p.awayTeam} @ ${p.homeTeam}`,
      commenceTime:   p.commenceTime,
      market:         p.marketType,
      marketKey:      p.marketKey,
      selection:      p.selection,
      line:           p.line,
      priceAtEval:    p.priceAtEval,
      modelProb:      `${(p.modelProb * 100).toFixed(1)}%`,
      modelEdge:      `${p.modelEdge > 0 ? '+' : ''}${(p.modelEdge * 100).toFixed(2)}%`,
      confidence:     p.confidenceTier,
      lineDelta:      p.lineDelta,
      isHighMove:     p.isHighMove,
      verdict:        p.confidenceTier === 'HIGH' ? 'BET'
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
    console.error('[nba-picks] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
