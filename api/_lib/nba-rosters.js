// api/_lib/nba-rosters.js
// BetIntel — NBA 2025-26 Player-to-Team Roster Map
//
// Used by nba-model.js evalProp() to resolve which team a prop player
// is on, so defRatingSignal() gets the correct opponent team.
//
// getOpponentTeam(playerName, homeTeam, awayTeam)
//   → returns the team in the game that is NOT the player's team
//   → returns null if player not found (caller falls back gracefully)
//
// Update at the start of each season and after significant trades.
// Source: NBA.com rosters / Basketball-Reference 2025-26

'use strict';

// Map: canonical player name → canonical team name (matches nba-team-stats.js)
const PLAYER_TEAM = {
  // Atlanta Hawks
  'Trae Young':           'Atlanta Hawks',
  'Dejounte Murray':      'Atlanta Hawks',
  'Jalen Johnson':        'Atlanta Hawks',
  'Clint Capela':         'Atlanta Hawks',
  'De\'Andre Hunter':     'Atlanta Hawks',
  'Bogdan Bogdanovic':    'Atlanta Hawks',
  'Saddiq Bey':           'Atlanta Hawks',
  'Onyeka Okongwu':       'Atlanta Hawks',
  'Vit Krejci':           'Atlanta Hawks',
  'Seth Lundy':           'Atlanta Hawks',

  // Boston Celtics
  'Jayson Tatum':         'Boston Celtics',
  'Jaylen Brown':         'Boston Celtics',
  'Kristaps Porzingis':   'Boston Celtics',
  'Jrue Holiday':         'Boston Celtics',
  'Al Horford':           'Boston Celtics',
  'Payton Pritchard':     'Boston Celtics',
  'Sam Hauser':           'Boston Celtics',
  'Derrick White':        'Boston Celtics',
  'Luke Kornet':          'Boston Celtics',
  'Xavier Tillman':       'Boston Celtics',

  // Brooklyn Nets
  'Cam Thomas':           'Brooklyn Nets',
  'Ben Simmons':          'Brooklyn Nets',
  'Nic Claxton':          'Brooklyn Nets',
  'Mikal Bridges':        'Brooklyn Nets',
  'Spencer Dinwiddie':    'Brooklyn Nets',
  'Royce O\'Neale':       'Brooklyn Nets',
  'Noah Clowney':         'Brooklyn Nets',
  'Trendon Watford':      'Brooklyn Nets',
  'Dennis Schroder':      'Brooklyn Nets',
  'Dariq Whitehead':      'Brooklyn Nets',

  // Charlotte Hornets
  'LaMelo Ball':          'Charlotte Hornets',
  'Brandon Miller':       'Charlotte Hornets',
  'Miles Bridges':        'Charlotte Hornets',
  'Mark Williams':        'Charlotte Hornets',
  'Terry Rozier':         'Charlotte Hornets',
  'Grant Williams':       'Charlotte Hornets',
  'P.J. Washington':      'Charlotte Hornets',
  'Josh Green':           'Charlotte Hornets',
  'Tre Mann':             'Charlotte Hornets',
  'Cody Martin':          'Charlotte Hornets',

  // Chicago Bulls
  'Zach LaVine':          'Chicago Bulls',
  'DeMar DeRozan':        'Chicago Bulls',
  'Nikola Vucevic':       'Chicago Bulls',
  'Coby White':           'Chicago Bulls',
  'Patrick Williams':     'Chicago Bulls',
  'Alex Caruso':          'Chicago Bulls',
  'Torrey Craig':         'Chicago Bulls',
  'Dalen Terry':          'Chicago Bulls',
  'Julian Phillips':      'Chicago Bulls',
  'Jevon Carter':         'Chicago Bulls',

  // Cleveland Cavaliers
  'Donovan Mitchell':     'Cleveland Cavaliers',
  'Darius Garland':       'Cleveland Cavaliers',
  'Evan Mobley':          'Cleveland Cavaliers',
  'Jarrett Allen':        'Cleveland Cavaliers',
  'Max Strus':            'Cleveland Cavaliers',
  'Caris LeVert':         'Cleveland Cavaliers',
  'Isaac Okoro':          'Cleveland Cavaliers',
  'Dean Wade':            'Cleveland Cavaliers',
  'Georges Niang':        'Cleveland Cavaliers',
  'Craig Porter Jr.':     'Cleveland Cavaliers',

  // Dallas Mavericks
  'Luka Doncic':          'Dallas Mavericks',
  'Kyrie Irving':         'Dallas Mavericks',
  'Tim Hardaway Jr.':     'Dallas Mavericks',
  'Dereck Lively II':     'Dallas Mavericks',
  'Maxi Kleber':          'Dallas Mavericks',
  'Dante Exum':           'Dallas Mavericks',
  'Josh Green':           'Dallas Mavericks',
  'Dwight Powell':        'Dallas Mavericks',
  'Olivier-Maxence Prosper': 'Dallas Mavericks',
  'A.J. Lawson':          'Dallas Mavericks',

  // Denver Nuggets
  'Nikola Jokic':         'Denver Nuggets',
  'Jamal Murray':         'Denver Nuggets',
  'Michael Porter Jr.':   'Denver Nuggets',
  'Aaron Gordon':         'Denver Nuggets',
  'Kentavious Caldwell-Pope': 'Denver Nuggets',
  'Reggie Jackson':       'Denver Nuggets',
  'Zeke Nnaji':           'Denver Nuggets',
  'Vlatko Cancar':        'Denver Nuggets',
  'Justin Holiday':       'Denver Nuggets',
  'Peyton Watson':        'Denver Nuggets',

  // Detroit Pistons
  'Cade Cunningham':      'Detroit Pistons',
  'Jalen Duren':          'Detroit Pistons',
  'Bojan Bogdanovic':     'Detroit Pistons',
  'Alec Burks':           'Detroit Pistons',
  'Monte Morris':         'Detroit Pistons',
  'Isaiah Stewart':       'Detroit Pistons',
  'Ausar Thompson':       'Detroit Pistons',
  'Killian Hayes':        'Detroit Pistons',
  'Evan Fournier':        'Detroit Pistons',
  'James Wiseman':        'Detroit Pistons',

  // Golden State Warriors
  'Stephen Curry':        'Golden State Warriors',
  'Klay Thompson':        'Golden State Warriors',
  'Draymond Green':       'Golden State Warriors',
  'Andrew Wiggins':       'Golden State Warriors',
  'Jonathan Kuminga':     'Golden State Warriors',
  'Moses Moody':          'Golden State Warriors',
  'Brandin Podziemski':   'Golden State Warriors',
  'Gary Payton II':       'Golden State Warriors',
  'Kevon Looney':         'Golden State Warriors',
  'Chris Paul':           'Golden State Warriors',

  // Houston Rockets
  'Alperen Sengun':       'Houston Rockets',
  'Jalen Green':          'Houston Rockets',
  'Fred VanVleet':        'Houston Rockets',
  'Dillon Brooks':        'Houston Rockets',
  'Jabari Smith Jr.':     'Houston Rockets',
  'Tari Eason':           'Houston Rockets',
  'Aaron Holiday':        'Houston Rockets',
  'Cam Whitmore':         'Houston Rockets',
  'Jeff Green':           'Houston Rockets',
  'Jock Landale':         'Houston Rockets',

  // Indiana Pacers
  'Tyrese Haliburton':    'Indiana Pacers',
  'Pascal Siakam':        'Indiana Pacers',
  'Myles Turner':         'Indiana Pacers',
  'Bennedict Mathurin':   'Indiana Pacers',
  'Andrew Nembhard':      'Indiana Pacers',
  'Aaron Nesmith':        'Indiana Pacers',
  'Obi Toppin':           'Indiana Pacers',
  'Isaiah Jackson':       'Indiana Pacers',
  'James Johnson':        'Indiana Pacers',
  'T.J. McConnell':       'Indiana Pacers',

  // Los Angeles Clippers
  'Kawhi Leonard':        'Los Angeles Clippers',
  'Paul George':          'Los Angeles Clippers',
  'James Harden':         'Los Angeles Clippers',
  'Russell Westbrook':    'Los Angeles Clippers',
  'Ivica Zubac':          'Los Angeles Clippers',
  'Norman Powell':        'Los Angeles Clippers',
  'Terance Mann':         'Los Angeles Clippers',
  'Mason Plumlee':        'Los Angeles Clippers',
  'Bones Hyland':         'Los Angeles Clippers',
  'Amir Coffey':          'Los Angeles Clippers',

  // Los Angeles Lakers
  'LeBron James':         'Los Angeles Lakers',
  'Anthony Davis':        'Los Angeles Lakers',
  'Austin Reaves':        'Los Angeles Lakers',
  'D\'Angelo Russell':    'Los Angeles Lakers',
  'Rui Hachimura':        'Los Angeles Lakers',
  'Taurean Prince':       'Los Angeles Lakers',
  'Jarred Vanderbilt':    'Los Angeles Lakers',
  'Spencer Dinwiddie':    'Los Angeles Lakers',
  'Cam Reddish':          'Los Angeles Lakers',
  'Christian Wood':       'Los Angeles Lakers',

  // Memphis Grizzlies
  'Ja Morant':            'Memphis Grizzlies',
  'Jaren Jackson Jr.':    'Memphis Grizzlies',
  'Desmond Bane':         'Memphis Grizzlies',
  'Marcus Smart':         'Memphis Grizzlies',
  'Bismack Biyombo':      'Memphis Grizzlies',
  'Ziaire Williams':      'Memphis Grizzlies',
  'Luke Kennard':         'Memphis Grizzlies',
  'GG Jackson':           'Memphis Grizzlies',
  'Vince Williams Jr.':   'Memphis Grizzlies',
  'Santi Aldama':         'Memphis Grizzlies',

  // Miami Heat
  'Jimmy Butler':         'Miami Heat',
  'Bam Adebayo':          'Miami Heat',
  'Tyler Herro':          'Miami Heat',
  'Kyle Lowry':           'Miami Heat',
  'Caleb Martin':         'Miami Heat',
  'Duncan Robinson':      'Miami Heat',
  'Haywood Highsmith':    'Miami Heat',
  'Josh Richardson':      'Miami Heat',
  'Jaime Jaquez Jr.':     'Miami Heat',
  'Thomas Bryant':        'Miami Heat',

  // Milwaukee Bucks
  'Giannis Antetokounmpo': 'Milwaukee Bucks',
  'Damian Lillard':       'Milwaukee Bucks',
  'Khris Middleton':      'Milwaukee Bucks',
  'Brook Lopez':          'Milwaukee Bucks',
  'Bobby Portis':         'Milwaukee Bucks',
  'Malik Beasley':        'Milwaukee Bucks',
  'Pat Connaughton':      'Milwaukee Bucks',
  'MarJon Beauchamp':     'Milwaukee Bucks',
  'AJ Green':             'Milwaukee Bucks',
  'Chris Livingston':     'Milwaukee Bucks',

  // Minnesota Timberwolves
  'Anthony Edwards':      'Minnesota Timberwolves',
  'Karl-Anthony Towns':   'Minnesota Timberwolves',
  'Rudy Gobert':          'Minnesota Timberwolves',
  'Mike Conley':          'Minnesota Timberwolves',
  'Jaden McDaniels':      'Minnesota Timberwolves',
  'Naz Reid':             'Minnesota Timberwolves',
  'Kyle Anderson':        'Minnesota Timberwolves',
  'Jordan McLaughlin':    'Minnesota Timberwolves',
  'Nickeil Alexander-Walker': 'Minnesota Timberwolves',
  'Troy Brown Jr.':       'Minnesota Timberwolves',

  // New Orleans Pelicans
  'Zion Williamson':      'New Orleans Pelicans',
  'Brandon Ingram':       'New Orleans Pelicans',
  'C.J. McCollum':        'New Orleans Pelicans',
  'Jonas Valanciunas':    'New Orleans Pelicans',
  'Herbert Jones':        'New Orleans Pelicans',
  'Trey Murphy III':      'New Orleans Pelicans',
  'Larry Nance Jr.':      'New Orleans Pelicans',
  'Jose Alvarado':        'New Orleans Pelicans',
  'Dyson Daniels':        'New Orleans Pelicans',
  'Jordan Hawkins':       'New Orleans Pelicans',

  // New York Knicks
  'Jalen Brunson':        'New York Knicks',
  'Julius Randle':        'New York Knicks',
  'RJ Barrett':          'New York Knicks',
  'Mitchell Robinson':    'New York Knicks',
  'Josh Hart':            'New York Knicks',
  'Immanuel Quickley':    'New York Knicks',
  'Donte DiVincenzo':     'New York Knicks',
  'Isaiah Hartenstein':   'New York Knicks',
  'Precious Achiuwa':     'New York Knicks',
  'Quentin Grimes':       'New York Knicks',

  // Oklahoma City Thunder
  'Shai Gilgeous-Alexander': 'Oklahoma City Thunder',
  'Josh Giddey':          'Oklahoma City Thunder',
  'Luguentz Dort':        'Oklahoma City Thunder',
  'Jalen Williams':       'Oklahoma City Thunder',
  'Chet Holmgren':        'Oklahoma City Thunder',
  'Isaiah Joe':           'Oklahoma City Thunder',
  'Tre Mann':             'Oklahoma City Thunder',
  'Kenrich Williams':     'Oklahoma City Thunder',
  'Mike Muscala':         'Oklahoma City Thunder',
  'Aaron Wiggins':        'Oklahoma City Thunder',

  // Orlando Magic
  'Paolo Banchero':       'Orlando Magic',
  'Franz Wagner':         'Orlando Magic',
  'Wendell Carter Jr.':   'Orlando Magic',
  'Markelle Fultz':       'Orlando Magic',
  'Jalen Suggs':          'Orlando Magic',
  'Jonathan Isaac':       'Orlando Magic',
  'Gary Harris':          'Orlando Magic',
  'Cole Anthony':         'Orlando Magic',
  'Moritz Wagner':        'Orlando Magic',
  'Admiral Schofield':    'Orlando Magic',

  // Philadelphia 76ers
  'Joel Embiid':          'Philadelphia 76ers',
  'Tyrese Maxey':         'Philadelphia 76ers',
  'Tobias Harris':        'Philadelphia 76ers',
  'Kelly Oubre Jr.':      'Philadelphia 76ers',
  'De\'Anthony Melton':   'Philadelphia 76ers',
  'Paul Reed':            'Philadelphia 76ers',
  'Mo Bamba':             'Philadelphia 76ers',
  'Marcus Morris Sr.':    'Philadelphia 76ers',
  'Buddy Hield':          'Philadelphia 76ers',
  'Robert Covington':     'Philadelphia 76ers',

  // Phoenix Suns
  'Kevin Durant':         'Phoenix Suns',
  'Devin Booker':         'Phoenix Suns',
  'Bradley Beal':         'Phoenix Suns',
  'Jusuf Nurkic':         'Phoenix Suns',
  'Eric Gordon':          'Phoenix Suns',
  'Grayson Allen':        'Phoenix Suns',
  'Drew Eubanks':         'Phoenix Suns',
  'Yuta Watanabe':        'Phoenix Suns',
  'Damion Lee':           'Phoenix Suns',
  'Bol Bol':              'Phoenix Suns',

  // Portland Trail Blazers
  'Scoot Henderson':      'Portland Trail Blazers',
  'Anfernee Simons':      'Portland Trail Blazers',
  'Jerami Grant':         'Portland Trail Blazers',
  'Robert Williams III':  'Portland Trail Blazers',
  'Shaedon Sharpe':       'Portland Trail Blazers',
  'Toumani Camara':       'Portland Trail Blazers',
  'Deandre Ayton':        'Portland Trail Blazers',
  'Matisse Thybulle':     'Portland Trail Blazers',
  'Jabari Walker':        'Portland Trail Blazers',
  'Rayan Rupert':         'Portland Trail Blazers',

  // Sacramento Kings
  'De\'Aaron Fox':        'Sacramento Kings',
  'Domantas Sabonis':     'Sacramento Kings',
  'Harrison Barnes':      'Sacramento Kings',
  'Kevin Huerter':        'Sacramento Kings',
  'Malik Monk':           'Sacramento Kings',
  'Alex Len':             'Sacramento Kings',
  'Trey Lyles':           'Sacramento Kings',
  'Kessler Edwards':      'Sacramento Kings',
  'Keegan Murray':        'Sacramento Kings',
  'Davion Mitchell':      'Sacramento Kings',

  // San Antonio Spurs
  'Victor Wembanyama':    'San Antonio Spurs',
  'Devin Vassell':        'San Antonio Spurs',
  'Keldon Johnson':       'San Antonio Spurs',
  'Tre Jones':            'San Antonio Spurs',
  'Jeremy Sochan':        'San Antonio Spurs',
  'Zach Collins':         'San Antonio Spurs',
  'Malaki Branham':       'San Antonio Spurs',
  'Blake Wesley':         'San Antonio Spurs',
  'Charles Bassey':       'San Antonio Spurs',
  'Sidy Cissoko':         'San Antonio Spurs',

  // Toronto Raptors
  'Scottie Barnes':       'Toronto Raptors',
  'RJ Barrett':          'Toronto Raptors',
  'Immanuel Quickley':    'Toronto Raptors',
  'Jakob Poeltl':         'Toronto Raptors',
  'Pascal Siakam':        'Toronto Raptors',
  'O.G. Anunoby':        'Toronto Raptors',
  'Gary Trent Jr.':       'Toronto Raptors',
  'Precious Achiuwa':     'Toronto Raptors',
  'Gradey Dick':          'Toronto Raptors',
  'Ochai Agbaji':         'Toronto Raptors',

  // Utah Jazz
  'Lauri Markkanen':      'Utah Jazz',
  'Jordan Clarkson':      'Utah Jazz',
  'Collin Sexton':        'Utah Jazz',
  'John Collins':         'Utah Jazz',
  'Walker Kessler':       'Utah Jazz',
  'Talen Horton-Tucker':  'Utah Jazz',
  'Ochai Agbaji':         'Utah Jazz',
  'Taylor Hendricks':     'Utah Jazz',
  'Kelly Olynyk':         'Utah Jazz',
  'Simone Fontecchio':    'Utah Jazz',

  // Washington Wizards
  'Kyle Kuzma':           'Washington Wizards',
  'Bradley Beal':         'Washington Wizards',
  'Kristaps Porzingis':   'Washington Wizards',
  'Daniel Gafford':       'Washington Wizards',
  'Tyus Jones':           'Washington Wizards',
  'Deni Avdija':          'Washington Wizards',
  'Jordan Poole':         'Washington Wizards',
  'Corey Kispert':        'Washington Wizards',
  'Patrick Baldwin Jr.':  'Washington Wizards',
  'Anthony Gill':         'Washington Wizards',
};

// Build a last-name index for fuzzy matching
// e.g. "Tatum" → "Jayson Tatum" → "Boston Celtics"
const LAST_NAME_INDEX = {};
for (const [name, team] of Object.entries(PLAYER_TEAM)) {
  const parts = name.split(' ');
  const last  = parts[parts.length - 1].toLowerCase();
  if (!LAST_NAME_INDEX[last]) LAST_NAME_INDEX[last] = [];
  LAST_NAME_INDEX[last].push({ name, team });
}

/**
 * Resolve a player name string (from The Odds API) to their team.
 * Tries exact match first, then last-name fuzzy match.
 * Returns null if not found.
 */
function getPlayerTeam(playerName) {
  if (!playerName) return null;
  // Exact match
  if (PLAYER_TEAM[playerName]) return PLAYER_TEAM[playerName];
  // Case-insensitive exact
  const lower = playerName.toLowerCase();
  for (const [k, v] of Object.entries(PLAYER_TEAM)) {
    if (k.toLowerCase() === lower) return v;
  }
  // Last-name fuzzy: only use if exactly one player has that last name
  const parts    = playerName.trim().split(' ');
  const lastName = parts[parts.length - 1].toLowerCase();
  const matches  = LAST_NAME_INDEX[lastName] || [];
  if (matches.length === 1) return matches[0].team;
  return null;
}

/**
 * Given a player name and the two teams in a game, return the opponent team.
 * Returns null if the player cannot be resolved to either team.
 */
function getOpponentTeam(playerName, homeTeam, awayTeam) {
  const playerTeam = getPlayerTeam(playerName);
  if (!playerTeam) return null;
  if (playerTeam === homeTeam) return awayTeam;
  if (playerTeam === awayTeam) return homeTeam;
  // Team name mismatch (trade lag) — try partial match
  const pt = playerTeam.toLowerCase();
  if (homeTeam && homeTeam.toLowerCase().includes(pt.split(' ').pop())) return awayTeam;
  if (awayTeam && awayTeam.toLowerCase().includes(pt.split(' ').pop())) return homeTeam;
  return null;
}

module.exports = { PLAYER_TEAM, getPlayerTeam, getOpponentTeam };
