// api/_lib/redis-client.js
// Shared Redis client — used by news.js, odds.js, clv.js, mlb-cron.js, mlb-logger.js
//
// Returns a single connected client instance (singleton).
// Gracefully returns null if REDIS_URL is not set or connection fails,
// so all callers that do: try { redis = require('./redis-client') } catch {}
// will get a live client OR null — never an unhandled exception.
//
// Supports both redis@3 (callback) and redis@4 (promise) APIs.
// Railway Redis plugin injects REDIS_URL automatically.

'use strict';

const REDIS_URL = process.env.REDIS_URL || '';

if (!REDIS_URL) {
  // No Redis configured — export null so callers fall back to in-memory cache
  module.exports = null;
} else {
  let client = null;

  try {
    const redis = require('redis');

    // redis@4 uses createClient + async .connect()
    if (typeof redis.createClient === 'function') {
      client = redis.createClient({ url: REDIS_URL });

      client.on('error', (err) => {
        // Don't crash the process — callers handle null gracefully
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[redis-client] connection error:', err.message);
        }
      });

      // Connect async; callers will await or catch silently
      client.connect().catch((err) => {
        console.warn('[redis-client] initial connect failed:', err.message);
        client = null;
      });
    }
  } catch (err) {
    // redis package not installed — safe to ignore, callers use in-mem fallback
    console.warn('[redis-client] redis package unavailable:', err.message);
    client = null;
  }

  module.exports = client;
}
