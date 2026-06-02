// api/picks-log.js
// BetIntel v2 — Picks Logger Endpoint
//
// GET  /api/picks-log               — fetch logged picks (with optional filters)
// POST /api/picks-log/resolve       — resolve a pick with outcome + close odds
//
// This endpoint is the bridge between the tennis-picks engine and the
// backtest calibration pipeline (api/calibration.js).

'use strict';

const { logPicks, resolvePick, fetchPicks, fetchPendingPickIds } = require('./_lib/picks-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // POST /api/picks-log/resolve
  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: 'Invalid JSON.' }); }

    const { pickId, closeOdds, closeOddsOpp, outcome } = body || {};
    if (!pickId)  return res.status(400).json({ error: 'pickId required.' });
    if (!outcome || !['win','loss'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be "win" or "loss".' });
    }

    const ok = await resolvePick(pickId, { closeOdds, closeOddsOpp, outcome });
    return res.status(ok ? 200 : 503).json({
      ok,
      pickId,
      message: ok ? 'Pick resolved.' : 'Redis unavailable — pick not persisted.',
    });
  }

  // GET /api/picks-log
  if (req.method === 'GET') {
    const limit        = Math.min(parseInt(req.query.limit || '200'), 1000);
    const resolvedOnly = req.query.resolved === 'true';
    const pendingOnly  = req.query.pending  === 'true';

    if (pendingOnly) {
      const ids = await fetchPendingPickIds();
      return res.status(200).json({ count: ids.length, pendingPickIds: ids });
    }

    const picks = await fetchPicks(limit, resolvedOnly);
    const resolved   = picks.filter(p => p.outcome);
    const unresolved = picks.filter(p => !p.outcome);

    return res.status(200).json({
      count:         picks.length,
      resolved:      resolved.length,
      unresolved:    unresolved.length,
      picks,
      note:          picks.length === 0 ? 'No picks logged yet. Picks are logged automatically when tennis-picks returns a BET or MARGINAL verdict.' : null,
    });
  }

  return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
};
