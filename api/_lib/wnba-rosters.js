// api/_lib/wnba-rosters.js
// BetIntel — WNBA 2025 Player-to-Team Roster Map
//
// Used by wnba-model.js evalProp() to resolve which team a prop player
// is on, so defRatingSignal() gets the correct opponent team.
//
// getOpponentTeam(playerName, homeTeam, awayTeam)
//   → returns the team in the game that is NOT the player's team
//   → returns null if player not found (graceful fallback)

'use strict';

const PLAYER_TEAM = {
  // Atlanta Dream
  'Rhyne Howard':          'Atlanta Dream',
  'Allisha Gray':          'Atlanta Dream',
  'Cheyenne Parker-Tyus':  'Atlanta Dream',
  'Erica Wheeler':         'Atlanta Dream',
  'Aerial Powers':         'Atlanta Dream',
  'Haley Jones':           'Atlanta Dream',
  'Maya Caldwell':         'Atlanta Dream',
  'Laeticia Amihere':      'Atlanta Dream',
  'Kristy Wallace':        'Atlanta Dream',
  'Naz Hillmon':           'Atlanta Dream',

  // Chicago Sky
  'Chennedy Carter':       'Chicago Sky',
  'Kahleah Copper':        'Chicago Sky',
  'Angel Reese':           'Chicago Sky',
  'Kamilla Cardoso':       'Chicago Sky',
  'Marina Mabrey':         'Chicago Sky',
  'Rebekah Gardner':       'Chicago Sky',
  'Dana Evans':            'Chicago Sky',
  'Elizabeth Williams':    'Chicago Sky',
  'Tiffany Mitchell':      'Chicago Sky',
  'Isabelle Harrison':     'Chicago Sky',

  // Connecticut Sun
  'Alyssa Thomas':         'Connecticut Sun',
  'DeWanna Bonner':        'Connecticut Sun',
  'Brionna Jones':         'Connecticut Sun',
  'DiJonai Carrington':    'Connecticut Sun',
  'Tiffany Hayes':         'Connecticut Sun',
  'Marina Mabrey':         'Connecticut Sun',
  'Rachel Banham':         'Connecticut Sun',
  'Lexi Brown':            'Connecticut Sun',
  'Tyasha Harris':         'Connecticut Sun',
  'Olivia Nelson-Ododa':   'Connecticut Sun',

  // Dallas Wings
  'Arike Ogunbowale':      'Dallas Wings',
  'Satou Sabally':         'Dallas Wings',
  'Natasha Howard':        'Dallas Wings',
  'Teaira McCowan':        'Dallas Wings',
  'Veronica Burton':       'Dallas Wings',
  'Lou Lopez Senechal':    'Dallas Wings',
  'Maddy Siegrist':        'Dallas Wings',
  'Odyssey Sims':          'Dallas Wings',
  'Crystal Dangerfield':   'Dallas Wings',
  'Kalani Brown':          'Dallas Wings',

  // Indiana Fever
  'Caitlin Clark':         'Indiana Fever',
  'Aliyah Boston':         'Indiana Fever',
  'Kelsey Mitchell':       'Indiana Fever',
  'NaLyssa Smith':         'Indiana Fever',
  'Lexie Hull':            'Indiana Fever',
  'Katie Lou Samuelson':   'Indiana Fever',
  'Erica Wheeler':         'Indiana Fever',
  'Sophie Cunningham':     'Indiana Fever',
  'Kristin Haynie':        'Indiana Fever',
  'Damiris Dantas':        'Indiana Fever',

  // Las Vegas Aces
  'A\'ja Wilson':           'Las Vegas Aces',
  'Kelsey Plum':           'Las Vegas Aces',
  'Jackie Young':          'Las Vegas Aces',
  'Chelsea Gray':          'Las Vegas Aces',
  'Candace Parker':        'Las Vegas Aces',
  'Kiah Stokes':           'Las Vegas Aces',
  'Aisha Sheppard':        'Las Vegas Aces',
  'Destiny Slocum':        'Las Vegas Aces',
  'Tiffany Hayes':         'Las Vegas Aces',
  'Jordan Horston':        'Las Vegas Aces',

  // Los Angeles Sparks
  'Dearica Hamby':         'Los Angeles Sparks',
  'Nneka Ogwumike':        'Los Angeles Sparks',
  'Lexie Brown':           'Los Angeles Sparks',
  'Layshia Clarendon':     'Los Angeles Sparks',
  'Azura Stevens':         'Los Angeles Sparks',
  'Olivia Miles':          'Los Angeles Sparks',
  'Stephanie Talbot':      'Los Angeles Sparks',
  'Jordin Canada':         'Los Angeles Sparks',
  'Li Yueru':              'Los Angeles Sparks',
  'Rickea Jackson':        'Los Angeles Sparks',

  // Minnesota Lynx
  'Napheesa Collier':      'Minnesota Lynx',
  'Courtney Williams':     'Minnesota Lynx',
  'Kayla McBride':         'Minnesota Lynx',
  'Dorka Juhasz':          'Minnesota Lynx',
  'Alanna Smith':          'Minnesota Lynx',
  'Crystal Dangerfield':   'Minnesota Lynx',
  'Bridget Carleton':      'Minnesota Lynx',
  'Jessica Shepard':       'Minnesota Lynx',
  'Cecilia Zandalasini':   'Minnesota Lynx',
  'Nikolina Milic':        'Minnesota Lynx',

  // New York Liberty
  'Breanna Stewart':       'New York Liberty',
  'Jonquel Jones':         'New York Liberty',
  'Sabrina Ionescu':       'New York Liberty',
  'Courtney Vandersloot':  'New York Liberty',
  'Betnijah Laney-Hamilton': 'New York Liberty',
  'Stefanie Dolson':       'New York Liberty',
  'Natasha Cloud':         'New York Liberty',
  'Nyara Sabally':         'New York Liberty',
  'Marine Johannes':       'New York Liberty',
  'Han Xu':                'New York Liberty',

  // Phoenix Mercury
  'Diana Taurasi':         'Phoenix Mercury',
  'Brittney Griner':       'Phoenix Mercury',
  'Sophie Cunningham':     'Phoenix Mercury',
  'Natasha Cloud':         'Phoenix Mercury',
  'Sug Sutton':            'Phoenix Mercury',
  'Charisma Osborne':      'Phoenix Mercury',
  'Rebecca Allen':         'Phoenix Mercury',
  'Kalani Brown':          'Phoenix Mercury',
  'Kia Nurse':             'Phoenix Mercury',
  'Moriah Jefferson':      'Phoenix Mercury',

  // Seattle Storm
  'Jewell Loyd':           'Seattle Storm',
  'Ezi Magbegor':          'Seattle Storm',
  'Jordan Horston':        'Seattle Storm',
  'Gabby Williams':        'Seattle Storm',
  'Skylar Diggins-Smith':  'Seattle Storm',
  'Tina Charles':          'Seattle Storm',
  'Mercedes Russell':      'Seattle Storm',
  'Nika Muhl':             'Seattle Storm',
  'Jade Melbourne':        'Seattle Storm',
  'Briann January':        'Seattle Storm',

  // Washington Mystics
  'Elena Delle Donne':     'Washington Mystics',
  'Ariel Atkins':          'Washington Mystics',
  'Shakira Austin':        'Washington Mystics',
  'Tianna Hawkins':        'Washington Mystics',
  'Natasha Cloud':         'Washington Mystics',
  'Emily Engstler':        'Washington Mystics',
  'Brittney Sykes':        'Washington Mystics',
  'Karlie Samuelson':      'Washington Mystics',
  'Myisha Hines-Allen':    'Washington Mystics',
  'Julie Allemand':        'Washington Mystics',
};

// Last-name index for fuzzy matching
const LAST_NAME_INDEX = {};
for (const [name, team] of Object.entries(PLAYER_TEAM)) {
  const parts = name.split(' ');
  const last  = parts[parts.length - 1].toLowerCase();
  if (!LAST_NAME_INDEX[last]) LAST_NAME_INDEX[last] = [];
  LAST_NAME_INDEX[last].push({ name, team });
}

function getPlayerTeam(playerName) {
  if (!playerName) return null;
  if (PLAYER_TEAM[playerName]) return PLAYER_TEAM[playerName];
  const lower = playerName.toLowerCase();
  for (const [k, v] of Object.entries(PLAYER_TEAM)) {
    if (k.toLowerCase() === lower) return v;
  }
  const parts    = playerName.trim().split(' ');
  const lastName = parts[parts.length - 1].toLowerCase();
  const matches  = LAST_NAME_INDEX[lastName] || [];
  if (matches.length === 1) return matches[0].team;
  return null;
}

function getOpponentTeam(playerName, homeTeam, awayTeam) {
  const playerTeam = getPlayerTeam(playerName);
  if (!playerTeam) return null;
  if (playerTeam === homeTeam) return awayTeam;
  if (playerTeam === awayTeam) return homeTeam;
  const pt = playerTeam.toLowerCase();
  if (homeTeam && homeTeam.toLowerCase().includes(pt.split(' ').pop())) return awayTeam;
  if (awayTeam && awayTeam.toLowerCase().includes(pt.split(' ').pop())) return homeTeam;
  return null;
}

module.exports = { PLAYER_TEAM, getPlayerTeam, getOpponentTeam };
