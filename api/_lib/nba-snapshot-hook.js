// api/_lib/nba-snapshot-hook.js
// BetIntel — Drop-in hook to wire snapshot logging into api/odds.js
//
// Usage: in api/odds.js, after successful live fetch, add:
//
//   const { maybeLogNbaSnapshot } = require('./_lib/nba-snapshot-hook');
//   // ... after normalizeEvents:
//   await maybeLogNbaSnapshot(sport, normalized);
//
// This keeps the logging concern isolated from the core odds handler.

'use strict';

const { logOddsSnapshot } = require('./nba-logger');

/**
 * Logs a snapshot only for NBA odds polls.
 * Fire-and-forget — never throws, never blocks the response.
 *
 * @param {string} sport      - e.g. 'basketball_nba'
 * @param {Array}  events     - normalizeEvents() output
 */
async function maybeLogNbaSnapshot(sport, events) {
  if (sport !== 'basketball_nba') return;
  try {
    await logOddsSnapshot(events);
  } catch (err) {
    // Silent — logging must never break the main odds response
    console.warn('[nba-snapshot-hook] non-fatal:', err.message);
  }
}

module.exports = { maybeLogNbaSnapshot };
