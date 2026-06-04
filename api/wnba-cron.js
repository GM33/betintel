// api/wnba-cron.js
// BetIntel — WNBA Daily Cron Orchestrator
//
// TWO Railway cron services:
//
//   1. Morning snapshot (10:00 AM ET / 14:00 UTC) — logs today's predictions
//      schedule = "0 14 * * *"
//      command  = "node -e \"require('./api/wnba-cron.js').snapshot()\""
//
//   2. Nightly resolve (05:00 AM ET / 09:00 UTC) — grades yesterday
//      schedule = "0 9 * * *"
//      command  = "node -e \"require('./api/wnba-cron.js').resolve()\""
//
// WNBA games typically tip between 7 PM – 10 PM ET, so morning snapshot
// at 10 AM ET captures pre-game lines before books sharpen.

'use strict';

const BASE_URL = process.env.BETINTEL_BASE_URL || 'https://betintel-production-a550.up.railway.app';
const SECRET   = process.env.CRON_SECRET || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-betintel-cron-secret': SECRET,
};

async function runSnapshot() {
  const markets = 'h2h,spreads,totals,player_points,player_rebounds,player_assists';
  const url     = `${BASE_URL}/api/wnba-picks?log=true&markets=${encodeURIComponent(markets)}`;
  const res     = await fetch(url, { headers: HEADERS });
  return res.json();
}

async function runResolve(date) {
  const res = await fetch(`${BASE_URL}/api/wnba-resolve`, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify({ date }),
  });
  return res.json();
}

async function snapshot() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[wnba-cron] Snapshot run for ${today}`);
  try {
    const result = await runSnapshot();
    console.log(`[wnba-cron] Snapshot complete: ${result.total ?? 0} picks (HIGH=${result.highConf ?? 0})`);
  } catch (err) {
    console.error('[wnba-cron] Snapshot failed:', err.message);
  }
  console.log('[wnba-cron] Snapshot pipeline done.');
}

async function resolve() {
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  console.log(`[wnba-cron] Resolve run for ${yesterday}`);

  try {
    const snap = await runSnapshot();
    console.log(`[wnba-cron] Pre-resolve snapshot: ${snap.total ?? 0} picks`);
  } catch (err) {
    console.warn('[wnba-cron] Pre-resolve snapshot failed (non-fatal):', err.message);
  }

  try {
    const result = await runResolve(yesterday);
    console.log('[wnba-cron] Resolve complete:', JSON.stringify(result));
  } catch (err) {
    console.error('[wnba-cron] Resolve failed:', err.message);
  }

  console.log('[wnba-cron] Resolve pipeline done.');
}

// CLI: node api/wnba-cron.js snapshot | resolve
if (require.main === module) {
  const step = process.argv[2] || 'resolve';
  if (step === 'snapshot') snapshot().catch(console.error);
  else resolve().catch(console.error);
}

// HTTP handler: POST /api/wnba-cron?step=snapshot|resolve
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-betintel-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const step = req.query?.step || 'resolve';
  if (step === 'snapshot') await snapshot();
  else await resolve();
  return res.status(200).json({ ok: true, step, message: `${step} pipeline complete` });
};

module.exports.snapshot = snapshot;
module.exports.resolve  = resolve;
