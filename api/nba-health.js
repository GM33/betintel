// api/nba-health.js
// BetIntel — NBA Pipeline Health Check
//
// GET /api/nba-health
//
// Returns a quick summary of the NBA data pipeline state:
//   - How many snapshots are stored in Redis
//   - How many predictions are logged (total, pending, resolved)
//   - CLV beat rate and hit rate so far
//   - Whether BDL key is configured
//   - Whether REDIS_URL is configured
//   - Last resolved prediction timestamp
//
// Use this to sanity-check the pipeline is running end-to-end.
// Hit it after your first /api/nba-picks call and after your first /api/nba-resolve run.

'use strict';

const { fetchPredictions, fetchPendingPredictionIds } = require('./_lib/nba-logger');

let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url });
    client.on('error', () => { _redis = null; });
    await client.connect();
    _redis = client;
    return _redis;
  } catch {
    return null;
  }
}

async function countSnapshotKeys(redis) {
  try {
    // SCAN for nba:snap:* keys — gives approximate count without blocking
    let cursor = 0;
    let count  = 0;
    do {
      const reply = await redis.scan(cursor, { MATCH: 'nba:snap:*', COUNT: 100 });
      cursor = reply.cursor;
      count += reply.keys.length;
    } while (cursor !== 0 && count < 5000);
    return count;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Cache-Control', 'no-store');

  const redisConfigured = !!process.env.REDIS_URL;
  const bdlKeyPresent   = !!process.env.BDL_API_KEY;
  const cronSecretSet   = !!process.env.CRON_SECRET;

  // Redis connectivity check
  const redis = await getRedis();
  const redisConnected = !!redis;

  // Snapshot count
  const snapshotKeys = redisConnected ? await countSnapshotKeys(redis) : null;

  // Prediction stats
  let totalPreds = 0, pendingCount = 0, resolvedCount = 0;
  let clvHits = 0, wins = 0;
  let lastResolvedAt = null;

  try {
    const [allPreds, pendingIds] = await Promise.all([
      fetchPredictions(2000, false),
      fetchPendingPredictionIds(),
    ]);

    totalPreds   = allPreds.length;
    pendingCount = pendingIds.length;

    const resolved = allPreds.filter(p =>
      p.resultOutcome === 'WIN' || p.resultOutcome === 'LOSE' || p.resultOutcome === 'PUSH'
    );
    resolvedCount = resolved.length;
    wins          = resolved.filter(p => p.resultOutcome === 'WIN').length;
    clvHits       = resolved.filter(p => p.clvBeaten).length;

    const lastResolved = resolved
      .filter(p => p.resolvedAt)
      .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt))[0];
    lastResolvedAt = lastResolved?.resolvedAt || null;
  } catch { /* non-fatal */ }

  const hitRate = resolvedCount ? parseFloat(((wins / resolvedCount) * 100).toFixed(1)) : null;
  const clvRate = resolvedCount ? parseFloat(((clvHits / resolvedCount) * 100).toFixed(1)) : null;

  // Pipeline readiness summary
  const issues = [];
  if (!redisConfigured)  issues.push('REDIS_URL not set — all logging is disabled');
  if (!redisConnected)   issues.push('Redis connection failed — check REDIS_URL is valid');
  if (!cronSecretSet)    issues.push('CRON_SECRET not set — /api/nba-resolve is unprotected');
  if (!bdlKeyPresent)    issues.push('BDL_API_KEY not set — using free v1 tier (60 req/min)');
  if (totalPreds === 0)  issues.push('No predictions logged yet — call /api/nba-picks first');
  if (resolvedCount === 0 && totalPreds > 0) {
    issues.push('No resolved predictions yet — call POST /api/nba-resolve after games finish');
  }

  const status =
    !redisConnected           ? 'OFFLINE' :
    issues.length === 0       ? 'HEALTHY' :
    issues.length <= 2        ? 'DEGRADED' : 'NEEDS_SETUP';

  return res.status(200).json({
    status,
    checkedAt:      new Date().toISOString(),
    env: {
      redisConfigured,
      redisConnected,
      bdlKeyPresent,
      cronSecretSet,
    },
    pipeline: {
      snapshotKeys,
      totalPredictions:    totalPreds,
      pendingPredictions:  pendingCount,
      resolvedPredictions: resolvedCount,
      hitRate:             hitRate    !== null ? `${hitRate}%`    : null,
      clvBeatRate:         clvRate    !== null ? `${clvRate}%`   : null,
      lastResolvedAt,
    },
    issues: issues.length ? issues : undefined,
  });
};
