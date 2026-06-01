const BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';

const ALLOWED_SPORTS = new Set(
  (process.env.BETINTEL_ALLOWED_SPORTS || 'baseball_mlb,basketball_nba,americanfootball_nfl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const ALLOWED_MARKETS = new Set(
  (process.env.BETINTEL_ALLOWED_MARKETS || 'h2h,spreads,totals')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAllowedSport(sport) {
  return ALLOWED_SPORTS.has(sport);
}

function sanitizeMarkets(markets) {
  const requested = String(markets || 'h2h')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const safe = requested.filter((m) => ALLOWED_MARKETS.has(m));
  return safe.length ? safe.join(',') : 'h2h';
}

function oddsUrl(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apiKey', process.env.ODDS_API_KEY);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  return url.toString();
}

async function fetchOdds(path, params = {}) {
  const response = await fetch(oddsUrl(path, params), {
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    quota: {
      remaining: response.headers.get('x-requests-remaining'),
      used: response.headers.get('x-requests-used'),
      last: response.headers.get('x-requests-last'),
    },
  };
}

module.exports = { isAllowedSport, sanitizeMarkets, fetchOdds };
