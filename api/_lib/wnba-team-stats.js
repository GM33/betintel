// api/_lib/wnba-team-stats.js
// BetIntel — WNBA 2025 Team Advanced Stats
//
// Pace, Offensive Rating, Defensive Rating, Net Rating
// Source: Basketball-Reference / Her Hoop Stats 2025 season
// League average pace: 83.20 (possessions per 40 min)
//
// Used by wnba-model.js for:
//   - paceInflationSignal() → totals model
//   - defRatingSignal()    → player prop model
//   - powerRatingSignal()  → moneyline + spread model

'use strict';

const LEAGUE_AVG_PACE    = 83.20;
const LEAGUE_AVG_DEF_RTG = 102.80; // WNBA league avg defensive rating 2025

const TEAM_STATS = {
  'Atlanta Dream':           { pace: 84.6, offRtg: 105.2, defRtg: 104.8, netRtg:  0.4 },
  'Chicago Sky':             { pace: 82.4, offRtg:  99.8, defRtg: 106.2, netRtg: -6.4 },
  'Connecticut Sun':         { pace: 81.8, offRtg: 104.6, defRtg:  99.4, netRtg:  5.2 },
  'Dallas Wings':            { pace: 84.2, offRtg:  98.4, defRtg: 108.6, netRtg: -10.2 },
  'Indiana Fever':           { pace: 85.1, offRtg: 106.8, defRtg: 103.2, netRtg:  3.6 },
  'Las Vegas Aces':          { pace: 83.8, offRtg: 110.4, defRtg:  99.8, netRtg: 10.6 },
  'Los Angeles Sparks':      { pace: 82.9, offRtg:  97.6, defRtg: 107.4, netRtg: -9.8 },
  'Minnesota Lynx':          { pace: 82.2, offRtg: 107.2, defRtg:  98.6, netRtg:  8.6 },
  'New York Liberty':        { pace: 83.6, offRtg: 109.8, defRtg: 100.2, netRtg:  9.6 },
  'Phoenix Mercury':         { pace: 83.4, offRtg: 103.4, defRtg: 104.6, netRtg: -1.2 },
  'Seattle Storm':           { pace: 83.0, offRtg: 105.8, defRtg: 101.4, netRtg:  4.4 },
  'Washington Mystics':      { pace: 83.8, offRtg:  96.2, defRtg: 109.8, netRtg: -13.6 },
};

const ALIASES = {
  'dream':     'Atlanta Dream',
  'atlanta':   'Atlanta Dream',
  'sky':       'Chicago Sky',
  'chicago':   'Chicago Sky',
  'sun':       'Connecticut Sun',
  'connecticut': 'Connecticut Sun',
  'wings':     'Dallas Wings',
  'dallas':    'Dallas Wings',
  'fever':     'Indiana Fever',
  'indiana':   'Indiana Fever',
  'aces':      'Las Vegas Aces',
  'vegas':     'Las Vegas Aces',
  'las vegas': 'Las Vegas Aces',
  'sparks':    'Los Angeles Sparks',
  'los angeles': 'Los Angeles Sparks',
  'lynx':      'Minnesota Lynx',
  'minnesota': 'Minnesota Lynx',
  'liberty':   'New York Liberty',
  'new york':  'New York Liberty',
  'mercury':   'Phoenix Mercury',
  'phoenix':   'Phoenix Mercury',
  'storm':     'Seattle Storm',
  'seattle':   'Seattle Storm',
  'mystics':   'Washington Mystics',
  'washington': 'Washington Mystics',
};

function getTeamStats(teamName) {
  if (!teamName) return null;
  if (TEAM_STATS[teamName]) return TEAM_STATS[teamName];
  const lower = teamName.toLowerCase();
  if (ALIASES[lower]) return TEAM_STATS[ALIASES[lower]];
  const words    = lower.split(' ');
  const lastWord = words[words.length - 1];
  if (ALIASES[lastWord]) return TEAM_STATS[ALIASES[lastWord]];
  for (const word of words) {
    if (ALIASES[word]) return TEAM_STATS[ALIASES[word]];
  }
  return null;
}

module.exports = { TEAM_STATS, LEAGUE_AVG_PACE, LEAGUE_AVG_DEF_RTG, getTeamStats };
