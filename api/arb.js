const { fetchOdds, isAllowedSport } = require('./_lib/odds');

// Calculate implied probability from American odds
function impliedProb(americanOdds) {
  if (americanOdds > 0) return 100 / (americanOdds + 100);
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

// Find arbitrage opportunities across bookmakers for a given event
function findArbs(events) {
  const opportunities = [];

  for (const event of events) {
    const h2hByBook = {};
    for (const book of event.bookmakers || []) {
      const h2h = (book.markets || []).find((m) => m.key === 'h2h');
      if (!h2h) continue;
      for (const outcome of h2h.outcomes || []) {
        if (!h2hByBook[outcome.name]) h2hByBook[outcome.name] = [];
        h2hByBook[outcome.name].push({ book: book.title, bookKey: book.key, price: outcome.price });
      }
    }

    const teams = Object.keys(h2hByBook);
    if (teams.length < 2) continue;

    // Best price for each side
    const bestByTeam = {};
    for (const team of teams) {
      const best = h2hByBook[team].reduce((a, b) => (a.price > b.price ? a : b));
      bestByTeam[team] = best;
    }

    // Sum of implied probabilities — arb exists if sum < 1
    const impliedSum = teams.reduce((sum, team) => sum + impliedProb(bestByTeam[team].price), 0);
    const arbPercent = ((1 - impliedSum) * 100).toFixed(2);

    if (impliedSum < 1) {
      opportunities.push({
        event_id: event.id,
        home_team: event.home_team,
        away_team: event.away_team,
        commence_time: event.commence_time,
        arb_percent: parseFloat(arbPercent),
        legs: teams.map((team) => ({
          team,
          book: bestByTeam[team].book,
          book_key: bestByTeam[team].bookKey,
          price: bestByTeam[team].price,
          implied_prob: parseFloat((impliedProb(bestByTeam[team].price) * 100).toFixed(2)),
        })),
      });
    }
  }

  // Sort by arb % descending
  return opportunities.sort((a, b) => b.arb_percent - a.arb_percent);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Tier gate: require pro header from frontend session (server enforced)
  const tier = req.headers['x-betintel-tier'] || 'free';
  if (tier === 'free') {
    return res.status(403).json({
      error: 'Pro subscription required',
      upgrade_url: 'https://www.betintel.bet/?upgrade=true',
    });
  }

  const sport = String(req.query.sport || 'baseball_mlb');
  if (!isAllowedSport(sport)) {
    return res.status(400).json({ error: 'Unsupported sport' });
  }

  try {
    const result = await fetchOdds(`/sports/${sport}/odds`, {
      regions: 'us',
      markets: 'h2h',
      oddsFormat: 'american',
      dateFormat: 'iso',
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: 'Failed to fetch odds for arb scan' });
    }

    const opportunities = findArbs(result.data);

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=30');
    return res.status(200).json({
      sport,
      count: opportunities.length,
      quota: result.quota,
      opportunities,
    });
  } catch (err) {
    console.error('[api/arb]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
