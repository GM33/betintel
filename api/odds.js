const { fetchOdds, isAllowedSport, sanitizeMarkets } = require('./_lib/odds');

function normalizeOdds(events) {
  return events.map((event) => ({
    id: event.id,
    sport: event.sport_key,
    commence_time: event.commence_time,
    home_team: event.home_team,
    away_team: event.away_team,
    books: (event.bookmakers || []).map((book) => ({
      key: book.key,
      title: book.title,
      last_update: book.last_update,
      markets: (book.markets || []).map((market) => ({
        key: market.key,
        outcomes: (market.outcomes || []).map((o) => ({
          name: o.name,
          price: o.price,
          point: o.point ?? null,
          description: o.description ?? null,
        })),
      })),
    })),
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sport = String(req.query.sport || 'baseball_mlb');
  if (!isAllowedSport(sport)) {
    return res.status(400).json({ error: 'Unsupported sport', allowed: ['baseball_mlb', 'basketball_nba', 'americanfootball_nfl'] });
  }

  const markets = sanitizeMarkets(req.query.markets);

  try {
    const result = await fetchOdds(`/sports/${sport}/odds`, {
      regions: 'us',
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: 'Failed to fetch odds', details: result.data });
    }

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
    return res.status(200).json({
      sport,
      markets,
      quota: result.quota,
      events: normalizeOdds(result.data),
    });
  } catch (err) {
    console.error('[api/odds]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
