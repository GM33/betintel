// api/nba-cron.js
// BetIntel — NBA Daily Cron Orchestrator
//
// TWO Railway cron services should call this file:
//
//   1. Morning snapshot (07:00 ET / 12:00 UTC) — logs today's predictions
//      schedule = "0 12 * * *"
//      command  = "node -e \"require('./api/nba-cron.js').snapshot()\""
//
//   2. Nightly resolve (03:00 ET / 08:00 UTC next day) — grades yesterday
//      schedule = "0 8 * * *"
//      command  = "node -e \"require('./api/nba-cron.js').resolve()\""
//
// Or expose POST /api/nba-cron?step=snapshot|resolve and hit via HTTP cron.
//
// Pipeline per day:
//   12:00 UTC — snapshot() logs HIGH+MED predictions for today's slate
//   08:00 UTC (next morning) — resolve() grades yesterday's logged predictions

'use strict';

// Fix: default to the live Railway URL, not the old Vercel URL
const BASE_URL = process.env.BETINTEL_BASE_URL || 'https://betintel-production-a550.up.railway.app';
const SECRET   = process.env.CRON_SECRET || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-betintel-cron-secret': SECRET,
};

// ── Step 1: Snapshot ──────────────────────────────────────────────────────────
// Hits /api/nba-picks with log=true so today's HIGH+MED predictions are written
// to Redis via nba-logger.logPrediction() before the nightly resolve runs.
// Markets: all default markets including props.

async function runSnapshot() {
  const markets = 'h2h,spreads,totals,player_points,player_rebounds,player_assists';
  const url = `${BASE_URL}/api/nba-picks?log=true&tier=&markets=${encodeURIComponent(markets)}`;
  const res = await fetch(url, { headers: HEADERS });
  const json = await res.json();
  return json;
}

// ── Step 2: Resolve ───────────────────────────────────────────────────────────
// Grades yesterday's logged predictions against final results.

async function runResolve(date) {
  const res = await fetch(`${BASE_URL}/api/nba-resolve`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ date }),
  });
  return res.json();
}

// ── Exported entrypoints ──────────────────────────────────────────────────────

async function snapshot() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[nba-cron] Snapshot run for ${today}`);
  try {
    const result = await runSnapshot();
    console.log(`[nba-cron] Snapshot complete: ${result.total ?? 0} picks logged (HIGH=${result.highConf ?? 0})`);
  } catch (err) {
    console.error(`[nba-cron] Snapshot failed:`, err.message);
  }
  console.log(`[nba-cron] Snapshot pipeline done.`);
}

async function resolve() {
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  console.log(`[nba-cron] Resolve run for ${yesterday}`);

  // Optional pre-resolve snapshot to catch any picks missed during the day
  try {
    const snap = await runSnapshot();
    console.log(`[nba-cron] Pre-resolve snapshot: ${snap.total ?? 0} picks`);
  } catch (err) {
    console.warn(`[nba-cron] Pre-resolve snapshot failed (non-fatal):`, err.message);
  }

  try {
    const resolveResult = await runResolve(yesterday);
    console.log(`[nba-cron] Resolve complete:`, JSON.stringify(resolveResult));
  } catch (err) {
    console.error(`[nba-cron] Resolve failed:`, err.message);
  }

  console.log(`[nba-cron] Resolve pipeline done.`);
}

// ── Direct CLI invocation ─────────────────────────────────────────────────────
// node api/nba-cron.js snapshot
// node api/nba-cron.js resolve

if (require.main === module) {
  const step = process.argv[2] || 'resolve';
  if (step === 'snapshot') {
    snapshot().catch(console.error);
  } else {
    resolve().catch(console.error);
  }
}

// ── Vercel / Express HTTP handler ─────────────────────────────────────────────
// POST /api/nba-cron?step=snapshot|resolve

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-betintel-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const step = req.query?.step || 'resolve';
  if (step === 'snapshot') {
    await snapshot();
  } else {
    await resolve();
  }

  return res.status(200).json({ ok: true, step, message: `${step} pipeline complete` });
};

module.exports.snapshot = snapshot;
module.exports.resolve  = resolve;
