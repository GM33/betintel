// api/_lib/odds.js
// BetIntel core odds connector — secure key handling, rate-limit tracking, error classification

const BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';

const ALLOWED_SPORTS = new Set(
  (process.env.BETINTEL_ALLOWED_SPORTS || 'baseball_mlb,basketball_nba,basketball_wnba,americanfootball_nfl,icehockey_nhl,soccer_epl,soccer_usa_mls')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const ALLOWED_MARKETS = new Set(
  (process.env.BETINTEL_ALLOWED_MARKETS || 'h2h,spreads,totals,player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals,player_turnovers')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
);

// Raised from 2500ms — NBA Finals responses are large (many bookmakers + prop markets)
const DEFAULT_TIMEOUT_MS = Number(process.env.ODDS_API_TIMEOUT_MS || 6000);

// ---- Rate-limit state (in-process; use Redis for multi-instance) ----
const rateLimitState = {
  remaining: null,
  used: null,
  last: null,
  updatedAt: null,
};

function getRateLimitState() {
  return { ...rateLimitState };
}

function updateRateLimitState(headers) {
  const remaining = headers.get ? headers.get('x-requests-remaining') : headers['x-requests-remaining'];
  const used = headers.get ? headers.get('x-requests-used') : headers['x-requests-used'];
  const last = headers.get ? headers.get('x-requests-last') : headers['x-requests-last'];

  if (remaining !== null && remaining !== undefined) rateLimitState.remaining = Number(remaining);
  if (used !== null && used !== undefined) rateLimitState.used = Number(used);
  if (last !== null && last !== undefined) rateLimitState.last = Number(last);
  rateLimitState.updatedAt = new Date().toISOString();
}

// ---- Error classification ----
const ERROR_CODES = {
  UNAUTHORIZED:    'UNAUTHORIZED_API_KEY',
  PLAN_LIMIT:      'PLAN_NOT_ALLOWED_OR_EXPIRED',
  NOT_FOUND:       'RESOURCE_NOT_FOUND',
  RATE_LIMIT:      'RATE_LIMIT_OR_QUOTA_EXCEEDED',
  SERVER_ERROR:    'PROVIDER_SERVER_ERROR',
  NETWORK_TIMEOUT: 'NETWORK_OR_TIMEOUT',
  UNKNOWN:         'UNKNOWN_CONNECTOR_ERROR',
};

function classifyError(status, body) {
  if (status === 401) return ERROR_CODES.UNAUTHORIZED;
  if (status === 403) return ERROR_CODES.PLAN_LIMIT;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMIT;
  if (status >= 500)  return ERROR_CODES.SERVER_ERROR;
  if (body && typeof body.message === 'string' && body.message.toLowerCase().includes('api key')) {
    return ERROR_CODES.UNAUTHORIZED;
  }
  return `HTTP_${status}`;
}

// ---- Implied probability ----
function impliedProb(americanPrice) {
  if (typeof americanPrice !== 'number' || isNaN(americanPrice)) return null;
  if (americanPrice > 0) return 100 / (americanPrice + 100);
  if (americanPrice < 0) return -americanPrice / (-americanPrice + 100);
  return null;
}

// ---- Sport / market helpers ----
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

// ---- Core fetch with timeout and retry ----
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOdds(path, params = {}, { retries = 1, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('apiKey', process.env.ODDS_API_KEY);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url.toString(), timeoutMs);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      updateRateLimitState(response.headers);

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          errorCode: classifyError(response.status, data),
          data,
          quota: getRateLimitState(),
        };
      }

      return {
        ok: true,
        status: response.status,
        data,
        quota: getRateLimitState(),
      };
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === 'AbortError';
      if (isAbort || attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  return {
    ok: false,
    status: 0,
    errorCode: ERROR_CODES.NETWORK_TIMEOUT,
    data: { message: lastErr ? lastErr.message : 'Request failed' },
    quota: getRateLimitState(),
  };
}

// ---- Normalization ----
function normalizeEvents(events, oddsFormat = 'american') {
  return (events || []).map((ev) => ({
    id: String(ev.id || ev.event_id || ''),
    sportKey: String(ev.sport_key || ''),
    sportTitle: String(ev.sport_title || ''),
    commenceTime: String(ev.commence_time || ''),
    completed: Boolean(ev.completed),
    homeTeam: String(ev.home_team || ''),
    awayTeam: String(ev.away_team || ''),
    isLive: Boolean(!ev.completed && ev.scores),
    bookmakers: (ev.bookmakers || []).map((bm) => ({
      bookmakerKey: String(bm.key || ''),
      title: String(bm.title || ''),
      lastUpdate: String(bm.last_update || ''),
      markets: (bm.markets || []).map((m) => ({
        marketKey: String(m.key || ''),
        outcomes: (m.outcomes || []).map((o) => {
          const price = Number(o.price ?? o.odds ?? NaN);
          const point = o.point != null ? Number(o.point) : null;
          return {
            name: String(o.name || o.description || ''),
            price,
            point,
            impliedProb: oddsFormat === 'american' ? impliedProb(price) : null,
            description: o.description ?? null,
          };
        }),
      })),
    })),
  }));
}

module.exports = {
  isAllowedSport,
  sanitizeMarkets,
  fetchOdds,
  normalizeEvents,
  getRateLimitState,
  ERROR_CODES,
};
