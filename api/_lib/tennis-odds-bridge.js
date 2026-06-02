// api/_lib/tennis-odds-bridge.js
// BetIntel v2 — Tennis Odds Bridge
//
// Pulls live tennis odds from The Odds API (already wired in api/odds.js),
// finds a match by player names, and enriches a props[] array with
// bookOddsOpp so the no-vig layer fires correctly in tennis-picks.js.
//
// This is the "immediately" item from the v2 build plan:
//   > Start passing bookOddsOpp on all two-sided props from your odds feed.

'use strict';

const { fetchOdds } = require('./odds');

const TENNIS_SPORT_KEY = process.env.TENNIS_SPORT_KEY || 'tennis_atp_french_open';

// Market key map: our internal names → Odds API market keys
const MARKET_KEY_MAP = {
  ml:           'h2h',
  total_games:  'totals',
  total_sets:   'totals',   // set totals if available
  set_spread:   'spreads',
  player_games_won: 'player_games',
};

/**
 * Fetches live odds for the configured tennis sport key,
 * finds the event matching playerA/playerB names (fuzzy),
 * and returns enriched props with bookOddsOpp injected.
 *
 * @param {string} playerAName
 * @param {string} playerBName
 * @param {Array}  props        - original props[] from request body
 * @param {string} sportKey     - override sport key (optional)
 * @returns {Promise<{ props: Array, eventFound: bool, eventId: string|null, vigAudit: object|null }>}
 */
async function enrichPropsWithOpp(playerAName, playerBName, props, sportKey) {
  const key = sportKey || TENNIS_SPORT_KEY;

  let oddsData;
  try {
    const result = await fetchOdds(`/sports/${key}/odds`, {
      regions: 'us',
      markets: 'h2h,totals,spreads',
      oddsFormat: 'american',
      dateFormat: 'iso',
    }, { retries: 1, timeoutMs: 3000 });

    if (!result.ok) {
      return { props, eventFound: false, eventId: null, vigAudit: null, error: result.errorCode };
    }
    oddsData = result.data;
  } catch (err) {
    return { props, eventFound: false, eventId: null, vigAudit: null, error: err.message };
  }

  // Find matching event (case-insensitive partial match on home/away team names)
  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const nA = normalize(playerAName);
  const nB = normalize(playerBName);

  const event = (oddsData || []).find(e => {
    const h = normalize(e.home_team);
    const a = normalize(e.away_team);
    return (h.includes(nA) || nA.includes(h)) && (a.includes(nB) || nB.includes(a)) ||
           (h.includes(nB) || nB.includes(h)) && (a.includes(nA) || nA.includes(a));
  });

  if (!event) {
    return { props, eventFound: false, eventId: null, vigAudit: null };
  }

  // Find the sharpest book (most balanced vig) — prefer pinnacle > draftkings > fanduel > first available
  const bookPriority = ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'caesars'];
  const bookmaker = bookPriority.reduce((best, bkey) => {
    return best || (event.bookmakers || []).find(b => b.key === bkey);
  }, null) || (event.bookmakers || [])[0];

  if (!bookmaker) {
    return { props, eventFound: true, eventId: event.id, vigAudit: null };
  }

  // Build a lookup: market_key → { outcomes[] }
  const marketLookup = {};
  (bookmaker.markets || []).forEach(m => { marketLookup[m.key] = m; });

  const h2h = marketLookup['h2h'];
  const totals = marketLookup['totals'];
  const spreads = marketLookup['spreads'];

  // Determine which player is home/away so sides map correctly
  const playerAIsHome = normalize(event.home_team).includes(nA) || nA.includes(normalize(event.home_team));

  // Enrich each prop with bookOddsOpp
  const enriched = props.map(prop => {
    const p = { ...prop };
    if (p.bookOddsOpp) return p; // already set — do not overwrite

    if (prop.market === 'ml' && h2h) {
      const outcomes = h2h.outcomes;
      const sideAOutcome = outcomes.find(o =>
        playerAIsHome ? normalize(o.name) === normalize(event.home_team) : normalize(o.name) === normalize(event.away_team)
      );
      const sideBOutcome = outcomes.find(o => o !== sideAOutcome);
      if (sideAOutcome && sideBOutcome) {
        if (prop.side === 'A') {
          p.bookOdds    = sideAOutcome.price;
          p.bookOddsOpp = sideBOutcome.price;
        } else {
          p.bookOdds    = sideBOutcome.price;
          p.bookOddsOpp = sideAOutcome.price;
        }
      }
    }

    if ((prop.market === 'total_games' || prop.market === 'total_sets') && totals) {
      const overOutcome  = totals.outcomes.find(o => o.name === 'Over');
      const underOutcome = totals.outcomes.find(o => o.name === 'Under');
      if (overOutcome && underOutcome) {
        p.line        = p.line || overOutcome.point;
        p.bookOdds    = prop.side === 'over' ? overOutcome.price : underOutcome.price;
        p.bookOddsOpp = prop.side === 'over' ? underOutcome.price : overOutcome.price;
      }
    }

    if (prop.market === 'set_spread' && spreads) {
      const outcomes = spreads.outcomes;
      const favOutcome  = outcomes.find(o => (o.point || 0) < 0);
      const dogOutcome  = outcomes.find(o => (o.point || 0) > 0);
      if (favOutcome && dogOutcome) {
        p.bookOdds    = prop.side === 'underdog_plus' ? dogOutcome.price  : favOutcome.price;
        p.bookOddsOpp = prop.side === 'underdog_plus' ? favOutcome.price  : dogOutcome.price;
        p.line        = p.line || Math.abs(dogOutcome.point || 1.5);
      }
    }

    return p;
  });

  // Quick vig audit on ML if h2h available
  let vigAudit = null;
  if (h2h && h2h.outcomes.length >= 2) {
    const [o1, o2] = h2h.outcomes;
    const raw1 = Math.abs(o1.price) / (Math.abs(o1.price) + 100);
    const raw2 = Math.abs(o2.price) / (Math.abs(o2.price) + 100);
    const overround = raw1 + raw2;
    vigAudit = {
      bookmaker:   bookmaker.key,
      vigPct:      parseFloat(((overround - 1) * 100).toFixed(3)),
      mlOutcomes:  h2h.outcomes.map(o => ({ name: o.name, odds: o.price })),
    };
  }

  return { props: enriched, eventFound: true, eventId: event.id, vigAudit, bookmakerUsed: bookmaker.key };
}

module.exports = { enrichPropsWithOpp, TENNIS_SPORT_KEY };
