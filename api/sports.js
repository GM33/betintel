const { fetchOdds } = require('./_lib/odds');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await fetchOdds('/sports');
    if (!result.ok) {
      return res.status(result.status).json({ error: 'Failed to fetch sports', details: result.data });
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ sports: result.data, quota: result.quota });
  } catch (err) {
    console.error('[api/sports]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
