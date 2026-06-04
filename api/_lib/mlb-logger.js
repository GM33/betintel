// api/_lib/mlb-logger.js
// BetIntel — MLB Prediction Logger (Redis-backed, mirrors nba-logger.js)

'use strict';

let redis;
try { redis = require('./redis-client'); } catch { redis = null; }

const TTL_SECONDS = 60 * 60 * 48;

function predKey(pred) {
  const selNorm = (pred.selection || '').replace(/\s+/g, '_').slice(0, 60);
  return `mlb:pred:${pred.gameId}:${pred.marketKey}:${selNorm}:${pred.book}`;
}
function openKey(gameId, marketKey, selKey, book) {
  return `mlb:open:${gameId}:${marketKey}:${selKey.replace(/\s+/g,'_').slice(0,60)}:${book}`;
}
function dailyKey(date) { return `mlb:daily:${date}`; }

async function logPrediction(pred) {
  if (!redis) return;
  try {
    const key  = predKey(pred);
    const date = (pred.commenceTime || new Date().toISOString()).slice(0, 10);
    const dKey = dailyKey(date);
    await redis.hset(key, {
      gameId: pred.gameId || '', homeTeam: pred.homeTeam || '', awayTeam: pred.awayTeam || '',
      commenceTime: pred.commenceTime || '', book: pred.book || '',
      marketType: pred.marketType || '', marketKey: pred.marketKey || '',
      selection: pred.selection || '', line: String(pred.line ?? ''),
      priceAtEval: String(pred.priceAtEval ?? ''), modelProb: String(pred.modelProb ?? ''),
      modelEdge: String(pred.modelEdge ?? ''), confidenceTier: pred.confidenceTier || 'LOW',
      lineDelta: String(pred.lineDelta ?? ''), isHighMove: pred.isHighMove ? '1' : '0',
      loggedAt: new Date().toISOString(), result: '', hit: '',
    });
    await redis.expire(key, TTL_SECONDS);
    await redis.zadd(dKey, Math.abs(pred.modelEdge || 0) * 1000, key);
    await redis.expire(dKey, TTL_SECONDS);
  } catch (err) { console.warn('[mlb-logger] logPrediction error:', err.message); }
}

async function snapshotOpenLine(gameId, marketKey, selKey, book, point, price) {
  if (!redis) return;
  try {
    const key = openKey(gameId, marketKey, selKey, book);
    const existing = await redis.hget(key, 'point');
    if (existing !== null) return;
    await redis.hset(key, { point: String(point ?? ''), price: String(price ?? ''), snappedAt: new Date().toISOString() });
    await redis.expire(key, TTL_SECONDS);
  } catch (err) { console.warn('[mlb-logger] snapshotOpenLine error:', err.message); }
}

async function getOpenClose(gameId, marketKey, selKey, book) {
  if (!redis) return null;
  try {
    const key  = openKey(gameId, marketKey, selKey, book);
    const open = await redis.hgetall(key);
    if (!open || !open.point) return null;
    return { open: { point: parseFloat(open.point), price: parseInt(open.price) } };
  } catch (err) { console.warn('[mlb-logger] getOpenClose error:', err.message); return null; }
}

async function resolvePrediction(predKeyStr, result, hit) {
  if (!redis) return;
  try {
    await redis.hset(predKeyStr, { result: result || '', hit: hit != null ? String(hit) : '', resolvedAt: new Date().toISOString() });
  } catch (err) { console.warn('[mlb-logger] resolvePrediction error:', err.message); }
}

module.exports = { logPrediction, snapshotOpenLine, getOpenClose, resolvePrediction, predKey, dailyKey };
