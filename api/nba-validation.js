// api/nba-validation.js
// BetIntel — NBA Model Validation Dashboard API
//
// GET /api/nba-validation?window=400&high_move=true
//
// Returns:
//  {
//    summary:           { n, hitRate, clvRate, roi, highMoveN, highMoveHitRate, highMoveRoi },
//    roi_series:        [{ game: N, all: $, hconf: $ }, ...],
//    clv_series:        [{ game: N, clvRate: % }, ...],        // rolling 20
//    accuracy_by_mkt:   [{ market, allAcc, highMoveAcc }, ...],
//    signal_corr:       [{ signal, r }, ...],
//    calibration:       [{ predProb, actualHit }, ...],
//  }

'use strict';

const { fetchPredictions } = require('./_lib/nba-logger');

// ── Stats helpers ─────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearsonR(xs, ys) {
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return dx2 && dy2 ? num / Math.sqrt(dx2 * dy2) : 0;
}

function americanToDecimal(american) {
  const a = parseInt(american);
  if (!a) return 1.909; // -110 default
  return a > 0 ? (a / 100) + 1 : (100 / Math.abs(a)) + 1;
}

// Rolling mean over a window of size W
function rolling(arr, w) {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - w + 1), i + 1);
    return mean(slice);
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const windowSize  = Math.min(parseInt(req.query.window  || '400'), 1000);
  const highMoveOnly = req.query.high_move === 'true';
  const ROLLING_WIN  = 20;

  try {
    const raw = await fetchPredictions(windowSize, true);
    if (!raw.length) return res.status(200).json({ error: 'No resolved predictions yet', n: 0 });

    // Sort oldest → newest for series computation
    const preds = raw
      .filter(p => p.resultOutcome === 'WIN' || p.resultOutcome === 'LOSE')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(-windowSize);

    const filtered = highMoveOnly ? preds.filter(p => p.isHighMove) : preds;

    // ── Summary ────────────────────────────────────────────────────────────
    const wins     = filtered.filter(p => p.resultOutcome === 'WIN').length;
    const hitRate  = filtered.length ? wins / filtered.length : 0;
    const clvHits  = filtered.filter(p => p.clvBeaten).length;
    const clvRate  = filtered.length ? clvHits / filtered.length : 0;
    const totalPnl = filtered.reduce((s, p) => s + (p.resultValue || 0), 0);
    const roi      = filtered.length ? (totalPnl / filtered.length) * 100 : 0;

    const hmPreds    = preds.filter(p => p.isHighMove);
    const hmWins     = hmPreds.filter(p => p.resultOutcome === 'WIN').length;
    const hmHitRate  = hmPreds.length ? hmWins / hmPreds.length : 0;
    const hmPnl      = hmPreds.reduce((s, p) => s + (p.resultValue || 0), 0);
    const hmRoi      = hmPreds.length ? (hmPnl / hmPreds.length) * 100 : 0;

    const hconfPreds = preds.filter(p => p.isHighMove && p.confidenceTier === 'HIGH');
    const hconfWins  = hconfPreds.filter(p => p.resultOutcome === 'WIN').length;
    const hconfHitRate = hconfPreds.length ? hconfWins / hconfPreds.length : 0;
    const hconfPnl   = hconfPreds.reduce((s, p) => s + (p.resultValue || 0), 0);
    const hconfRoi   = hconfPreds.length ? (hconfPnl / hconfPreds.length) * 100 : 0;

    // ── ROI Series (bankroll curve) ────────────────────────────────────────
    let allBr = 100, hconfBr = 100;
    const roiSeries = preds.map((p, i) => {
      const dec = americanToDecimal(p.closingPrice);
      allBr   += p.resultOutcome === 'WIN' ? (dec - 1) : -1;

      const isHconf = p.isHighMove && p.confidenceTier === 'HIGH';
      if (isHconf) hconfBr += p.resultOutcome === 'WIN' ? (dec - 1) : -1;

      return { game: i + 1, all: parseFloat(allBr.toFixed(2)), hconf: parseFloat(hconfBr.toFixed(2)) };
    });

    // ── Rolling CLV Series ────────────────────────────────────────────────
    const clvArr = preds.map(p => p.clvBeaten ? 1 : 0);
    const clvRolling = rolling(clvArr, ROLLING_WIN);
    const clvSeries  = preds.map((_, i) => ({
      game: i + 1,
      clvRate: parseFloat((clvRolling[i] * 100).toFixed(1)),
    }));

    // ── Accuracy by Market Type ───────────────────────────────────────────
    const MARKET_TYPES = ['PROP', 'SPREAD', 'TOTAL', 'MONEYLINE'];
    const accuracyByMkt = MARKET_TYPES.map(mt => {
      const mtPreds  = preds.filter(p => p.marketType === mt);
      const mtHm     = mtPreds.filter(p => p.isHighMove);
      const acc      = mtPreds.length  ? mtPreds.filter(p => p.resultOutcome === 'WIN').length  / mtPreds.length  : null;
      const hmAcc    = mtHm.length     ? mtHm.filter(p => p.resultOutcome === 'WIN').length     / mtHm.length     : null;
      return {
        market:       mt,
        n:            mtPreds.length,
        allAcc:       acc  != null ? parseFloat((acc  * 100).toFixed(1)) : null,
        highMoveAcc:  hmAcc != null ? parseFloat((hmAcc * 100).toFixed(1)) : null,
      };
    }).filter(r => r.n > 0);

    // ── Signal Correlations ───────────────────────────────────────────────
    // Each signal is a binary flag (1/0) computed from prediction metadata.
    // correlate each signal with (resultOutcome === 'WIN' ? 1 : 0)

    const outcomes  = preds.map(p => p.resultOutcome === 'WIN' ? 1 : 0);
    const edgeVals  = preds.map(p => p.modelEdge || 0);

    const signals = [
      { name: 'isHighMove',  vals: preds.map(p => p.isHighMove ? 1 : 0) },
      { name: 'highConf',    vals: preds.map(p => p.confidenceTier === 'HIGH' ? 1 : 0) },
      { name: 'isProp',      vals: preds.map(p => p.marketType === 'PROP' ? 1 : 0) },
      { name: 'modelEdge',   vals: edgeVals },
      { name: 'clvBeaten',   vals: preds.map(p => p.clvBeaten ? 1 : 0) },
    ];

    const signalCorr = signals.map(s => ({
      signal: s.name,
      r:      parseFloat(pearsonR(s.vals, outcomes).toFixed(3)),
    })).sort((a, b) => b.r - a.r);

    // ── Calibration ───────────────────────────────────────────────────────
    // Bucket modelProb into 0.05-wide bins; compute actual hit rate per bucket
    const bins = {};
    for (const p of preds) {
      if (p.modelProb == null) continue;
      const bucket = (Math.round(p.modelProb * 20) / 20).toFixed(2); // 0.50, 0.55 …
      if (!bins[bucket]) bins[bucket] = { wins: 0, n: 0 };
      bins[bucket].n++;
      if (p.resultOutcome === 'WIN') bins[bucket].wins++;
    }
    const calibration = Object.entries(bins)
      .map(([prob, b]) => ({
        predProb:   parseFloat(prob),
        actualHit:  b.n >= 5 ? parseFloat((b.wins / b.n).toFixed(3)) : null,
        n:          b.n,
      }))
      .filter(b => b.actualHit !== null)
      .sort((a, b) => a.predProb - b.predProb);

    // ── Response ──────────────────────────────────────────────────────────
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      summary: {
        n:               preds.length,
        hitRate:         parseFloat((hitRate  * 100).toFixed(1)),
        clvRate:         parseFloat((clvRate  * 100).toFixed(1)),
        roi:             parseFloat(roi.toFixed(2)),
        highMoveN:       hmPreds.length,
        highMoveHitRate: parseFloat((hmHitRate  * 100).toFixed(1)),
        highMoveRoi:     parseFloat(hmRoi.toFixed(2)),
        highConfN:       hconfPreds.length,
        highConfHitRate: parseFloat((hconfHitRate * 100).toFixed(1)),
        highConfRoi:     parseFloat(hconfRoi.toFixed(2)),
      },
      roi_series:      roiSeries,
      clv_series:      clvSeries,
      accuracy_by_mkt: accuracyByMkt,
      signal_corr:     signalCorr,
      calibration,
    });

  } catch (err) {
    console.error('[nba-validation] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
