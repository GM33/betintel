// api/_lib/nba-team-stats.js
// BetIntel — NBA 2025-26 Team Advanced Stats
//
// Pace, Offensive Rating, Defensive Rating, Net Rating
// Source: Basketball-Reference / NBA Advanced Stats (2025-26 season)
// League average pace: 100.50
//
// Used by nba-model.js for:
//   - paceInflationSignal() → totals model
//   - defRatingSignal()    → player prop model
//   - powerRatingSignal()  → moneyline + spread model
//
// Update this file at the start of each new season or after major trades.

'use strict';

const LEAGUE_AVG_PACE    = 100.50;
const LEAGUE_AVG_DEF_RTG = 114.07; // league avg defensive rating 2025-26

// Full 30-team dataset
const TEAM_STATS = {
  'Atlanta Hawks':          { pace: 103.2, offRtg: 114.1, defRtg: 117.2, netRtg: -3.1 },
  'Boston Celtics':         { pace:  99.8, offRtg: 121.2, defRtg: 110.1, netRtg: 11.1 },
  'Brooklyn Nets':          { pace:  98.6, offRtg: 108.4, defRtg: 119.8, netRtg: -11.4 },
  'Charlotte Hornets':      { pace: 101.4, offRtg: 109.7, defRtg: 118.9, netRtg: -9.2 },
  'Chicago Bulls':          { pace:  99.1, offRtg: 111.8, defRtg: 116.2, netRtg: -4.4 },
  'Cleveland Cavaliers':    { pace:  97.4, offRtg: 118.9, defRtg: 110.8, netRtg: 8.1 },
  'Dallas Mavericks':       { pace: 100.2, offRtg: 116.7, defRtg: 113.2, netRtg: 3.5 },
  'Denver Nuggets':         { pace: 101.8, offRtg: 117.4, defRtg: 112.6, netRtg: 4.8 },
  'Detroit Pistons':        { pace: 100.6, offRtg: 110.2, defRtg: 117.4, netRtg: -7.2 },
  'Golden State Warriors':  { pace: 102.1, offRtg: 114.8, defRtg: 114.9, netRtg: -0.1 },
  'Houston Rockets':        { pace: 100.9, offRtg: 115.6, defRtg: 111.4, netRtg: 4.2 },
  'Indiana Pacers':         { pace: 104.8, offRtg: 119.2, defRtg: 116.8, netRtg: 2.4 },
  'Los Angeles Clippers':   { pace:  98.9, offRtg: 112.4, defRtg: 114.1, netRtg: -1.7 },
  'Los Angeles Lakers':     { pace: 100.4, offRtg: 115.2, defRtg: 113.8, netRtg: 1.4 },
  'Memphis Grizzlies':      { pace: 102.4, offRtg: 113.6, defRtg: 112.9, netRtg: 0.7 },
  'Miami Heat':             { pace:  98.2, offRtg: 110.9, defRtg: 113.4, netRtg: -2.5 },
  'Milwaukee Bucks':        { pace: 101.1, offRtg: 116.8, defRtg: 114.6, netRtg: 2.2 },
  'Minnesota Timberwolves': { pace:  98.7, offRtg: 116.1, defRtg: 108.9, netRtg: 7.2 },
  'New Orleans Pelicans':   { pace:  99.8, offRtg: 109.8, defRtg: 116.7, netRtg: -6.9 },
  'New York Knicks':        { pace:  97.6, offRtg: 115.4, defRtg: 111.2, netRtg: 4.2 },
  'Oklahoma City Thunder':  { pace: 100.1, offRtg: 119.8, defRtg: 108.6, netRtg: 11.2 },
  'Orlando Magic':          { pace:  96.8, offRtg: 111.2, defRtg: 108.4, netRtg: 2.8 },
  'Philadelphia 76ers':     { pace:  99.4, offRtg: 111.6, defRtg: 116.4, netRtg: -4.8 },
  'Phoenix Suns':           { pace: 100.8, offRtg: 113.4, defRtg: 115.6, netRtg: -2.2 },
  'Portland Trail Blazers': { pace: 101.6, offRtg: 109.2, defRtg: 118.4, netRtg: -9.2 },
  'Sacramento Kings':       { pace: 103.6, offRtg: 115.8, defRtg: 116.2, netRtg: -0.4 },
  'San Antonio Spurs':      { pace: 102.8, offRtg: 110.4, defRtg: 117.8, netRtg: -7.4 },
  'Toronto Raptors':        { pace: 100.2, offRtg: 109.6, defRtg: 117.2, netRtg: -7.6 },
  'Utah Jazz':              { pace: 101.4, offRtg: 108.8, defRtg: 119.6, netRtg: -10.8 },
  'Washington Wizards':     { pace: 101.2, offRtg: 107.4, defRtg: 121.2, netRtg: -13.8 },
};

// Alias map: normalizes team names from The Odds API to canonical names above
const ALIASES = {
  'hawks':        'Atlanta Hawks',
  'celtics':      'Boston Celtics',
  'nets':         'Brooklyn Nets',
  'hornets':      'Charlotte Hornets',
  'bulls':        'Chicago Bulls',
  'cavaliers':    'Cleveland Cavaliers',
  'cavs':         'Cleveland Cavaliers',
  'mavericks':    'Dallas Mavericks',
  'mavs':         'Dallas Mavericks',
  'nuggets':      'Denver Nuggets',
  'pistons':      'Detroit Pistons',
  'warriors':     'Golden State Warriors',
  'rockets':      'Houston Rockets',
  'pacers':       'Indiana Pacers',
  'clippers':     'Los Angeles Clippers',
  'lakers':       'Los Angeles Lakers',
  'grizzlies':    'Memphis Grizzlies',
  'heat':         'Miami Heat',
  'bucks':        'Milwaukee Bucks',
  'timberwolves': 'Minnesota Timberwolves',
  'wolves':       'Minnesota Timberwolves',
  'pelicans':     'New Orleans Pelicans',
  'knicks':       'New York Knicks',
  'thunder':      'Oklahoma City Thunder',
  'magic':        'Orlando Magic',
  '76ers':        'Philadelphia 76ers',
  'sixers':       'Philadelphia 76ers',
  'suns':         'Phoenix Suns',
  'trail blazers': 'Portland Trail Blazers',
  'blazers':      'Portland Trail Blazers',
  'kings':        'Sacramento Kings',
  'spurs':        'San Antonio Spurs',
  'raptors':      'Toronto Raptors',
  'jazz':         'Utah Jazz',
  'wizards':      'Washington Wizards',
};

/**
 * Resolve a team name string (from The Odds API) to its canonical stats entry.
 * Returns null if not found — callers must handle gracefully.
 */
function getTeamStats(teamName) {
  if (!teamName) return null;
  // Direct match
  if (TEAM_STATS[teamName]) return TEAM_STATS[teamName];
  // Alias match (lowercase last word or full name)
  const lower = teamName.toLowerCase();
  if (ALIASES[lower]) return TEAM_STATS[ALIASES[lower]];
  // Partial match on last word (e.g., "OKC Thunder" → "thunder")
  const words = lower.split(' ');
  const lastWord = words[words.length - 1];
  if (ALIASES[lastWord]) return TEAM_STATS[ALIASES[lastWord]];
  // Partial match on any word
  for (const word of words) {
    if (ALIASES[word]) return TEAM_STATS[ALIASES[word]];
  }
  return null;
}

module.exports = { TEAM_STATS, LEAGUE_AVG_PACE, LEAGUE_AVG_DEF_RTG, getTeamStats };
