const { fetchOdds, isAllowedSport, sanitizeMarkets } = require('./_lib/odds');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sport = String(req.query.sport || '');
  const eventId = String(req.query.eventId || '');
  const markets = sanitizeMarkets(req.query.markets || 'h2h');

  if (!sport || !eventId) {
    return res.status(400).json({ error: 'sport and eventId are required' });
  }

  if (!isAllowedSport(sport)) {
    return res.status(400).json({ error: 'Unsupported sport' });
  }

  try {
    const result = await fetchOdds(`/sports/${sport}/events/${eventId}/odds`, {
      regions: 'us',
      markets,
      oddsFormat: 'american',
      dateFormat: 'iso',
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: 'Failed to fetch event odds', details: result.data });
    }

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(200).json({ quota: result.quota, event: result.data });
  } catch (err) {
    console.error('[api/event-odds]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
