// api/nba-cron.js
// BetIntel — NBA Daily Cron Orchestrator
//
// Called by Railway cron at 03:00 AM ET every day.
// Runs the full nightly pipeline:
//   1. POST /api/nba-resolve  — grade yesterday's pending predictions
//   2. Logs summary to console (Railway will capture this)
//
// Railway cron config (add to railway.toml or Railway dashboard):
//   [cron]
//   schedule = "0 8 * * *"   # 03:00 ET = 08:00 UTC
//   command  = "node -e \"require('./api/nba-cron.js')()\""
//
// Alternatively: expose POST /api/nba-cron and set Railway HTTP cron to hit it.

'use strict';

const BASE_URL = process.env.BETINTEL_BASE_URL || 'https://betintel.vercel.app';
const SECRET   = process.env.CRON_SECRET || '';

async function runResolve(date) {
  const res = await fetch(`${BASE_URL}/api/nba-resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-betintel-cron-secret': SECRET,
    },
    body: JSON.stringify({ date }),
  });
  return res.json();
}

async function main() {
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  console.log(`[nba-cron] Starting nightly pipeline for ${yesterday}`);

  try {
    const resolveResult = await runResolve(yesterday);
    console.log(`[nba-cron] Resolve complete:`, JSON.stringify(resolveResult));
  } catch (err) {
    console.error(`[nba-cron] Resolve failed:`, err.message);
  }

  console.log(`[nba-cron] Pipeline complete.`);
}

// Allow direct invocation: node api/nba-cron.js
if (require.main === module) {
  main().catch(console.error);
}

// Also export as Vercel handler (POST /api/nba-cron)
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-betintel-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await main();
  return res.status(200).json({ ok: true, message: 'Cron pipeline complete' });
};

module.exports.main = main;
