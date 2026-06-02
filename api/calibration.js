// api/calibration.js
// BetIntel v2 — CLV + Backtest Calibration Endpoint
//
// GET /api/calibration
//   Fetches all resolved picks from Redis, runs backtest.evaluate(),
//   and returns the full calibration report.
//
// This is the primary sharpness dashboard for the BetIntel engine.
// Wire this to an internal dashboard or scheduled job.
//
// Key metrics returned:
//   - CLV (closing line value) — primary sharpness signal
//   - Hit rate by confidence tier vs expected hit rate
//   - Brier score (calibration quality)
//   - Edge distribution
//   - Per-market breakdown
//   - Minimum sample warning if < 30 resolved picks

'use strict';

const { evaluate, clvSummary, hitRateByTier, brierScore, edgeDistribution } = require('./_lib/backtest');
const { fetchPicks } = require('./_lib/picks-store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  res.setHeader('Cache-Control', 'no-store');

  // Optional filters
  const marketFilter     = req.query.market     || null;
  const confidenceFilter = req.query.confidence || null;
  const limitRaw         = Math.min(parseInt(req.query.limit || '1000'), 5000);

  let picks;
  try {
    picks = await fetchPicks(limitRaw, false);
  } catch (err) {
    return res.status(503).json({ error: 'Could not fetch picks from store.', detail: err.message });
  }

  // Apply filters
  let filtered = picks;
  if (marketFilter)     filtered = filtered.filter(p => p.market === marketFilter);
  if (confidenceFilter) filtered = filtered.filter(p => p.confidence === confidenceFilter);

  const resolved   = filtered.filter(p => p.outcome === 'win' || p.outcome === 'loss');
  const unresolved = filtered.filter(p => !p.outcome);

  // Full calibration report
  const report = evaluate(resolved);

  // Per-market breakdown
  const markets = [...new Set(resolved.map(p => p.market))];
  const byMarket = {};
  markets.forEach(m => {
    const mPicks = resolved.filter(p => p.market === m);
    const mHits  = mPicks.filter(p => p.outcome === 'win').length;
    const avgEdge = mPicks.reduce((s,p) => s + (parseFloat(p.edgePts) || 0), 0) / mPicks.length;
    const clv     = clvSummary(mPicks);
    byMarket[m] = {
      picks:        mPicks.length,
      hits:         mHits,
      hitRate:      mPicks.length ? parseFloat((mHits/mPicks.length).toFixed(4)) : null,
      avgEdgePts:   parseFloat(avgEdge.toFixed(2)),
      clv:          clv.avgCLV,
      clvStatus:    clv.interpretation,
    };
  });

  // Confidence tier breakdown
  const tierBreakdown = hitRateByTier(resolved);

  // Kelly sizing recommendation based on CLV
  let kellySizing = null;
  if (report.clv?.avgCLV !== null) {
    const clv = report.clv.avgCLV;
    kellySizing = clv >= 3    ? 'Full Kelly on HIGH confidence, Half Kelly on MEDIUM' :
                  clv >= 1.5  ? 'Half Kelly on HIGH confidence, Quarter Kelly on MEDIUM' :
                  clv >= 0    ? 'Quarter Kelly max — model not yet proven sharp' :
                                'DO NOT SIZE — negative CLV. Model is losing to the market.';
  }

  return res.status(200).json({
    meta: {
      generatedAt:       new Date().toISOString(),
      totalPicksInStore: picks.length,
      filteredPicks:     filtered.length,
      resolvedPicks:     resolved.length,
      unresolvedPicks:   unresolved.length,
      filters:           { market: marketFilter, confidence: confidenceFilter },
      engineVersion:     'v2-serve-return-no-vig',
    },
    clv:            report.clv,
    hitRates:       tierBreakdown,
    brierScore:     report.brierScore,
    edgeDistrib:    report.edgeDistrib,
    byMarket,
    kellySizing,
    interpretation: report.interpretation,
    sampleWarning:  resolved.length < 30
      ? `Only ${resolved.length} resolved picks. Need 30+ for meaningful calibration. Keep logging.`
      : null,
    rawResolved:    req.query.raw === 'true' ? resolved : undefined,
  });
};
