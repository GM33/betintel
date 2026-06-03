import requests
import psycopg2
import psycopg2.extras
from datetime import datetime, date
from wnba.config import ODDS_BASE, ODDS_API_KEY, DATABASE_URL, WNBA_SPORT_KEY, WNBA_REGIONS
import logging

log = logging.getLogger("betintel.wnba.ingestion.odds")

GAME_MARKETS   = ["h2h", "spreads", "totals"]


def get_db():
    return psycopg2.connect(DATABASE_URL)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _upsert_game(cur, event: dict, today: date):
    """Insert game row into wnba_games if not already present."""
    cur.execute("""
        INSERT INTO wnba_games (
            game_id, season, season_type,
            game_date, tipoff_time,
            home_team_id, away_team_id,
            status, updated_at
        ) VALUES (%s, %s, 'REG', %s, %s, %s, %s, 'SCHEDULED', NOW())
        ON CONFLICT (game_id) DO UPDATE
            SET tipoff_time  = EXCLUDED.tipoff_time,
                updated_at   = NOW()
    """, (
        event["id"],
        str(today.year),
        today,
        event["commence_time"],
        event["home_team"],   # team_id = team name until wnba_teams seed exists
        event["away_team"],
    ))


def _insert_history(cur, game_id: str, bookmaker: str,
                    market_group: str, market_type: str,
                    payload: dict, snapshot_type: str, ts: datetime):
    """Append one row to wnba_odds_history."""
    cur.execute("""
        INSERT INTO wnba_odds_history (
            game_id, player_id, bookmaker,
            market_group, market_type, is_live,
            home_moneyline, away_moneyline,
            spread_line, spread_home_odds, spread_away_odds,
            total_line, total_over_odds, total_under_odds,
            prop_line, prop_over_odds, prop_under_odds,
            snapshot_source, snapshot_type, snapshot_ts
        ) VALUES (
            %(game_id)s, %(player_id)s, %(bookmaker)s,
            %(market_group)s, %(market_type)s, FALSE,
            %(home_ml)s, %(away_ml)s,
            %(spread_line)s, %(spread_home)s, %(spread_away)s,
            %(total_line)s, %(total_over)s, %(total_under)s,
            %(prop_line)s, %(prop_over)s, %(prop_under)s,
            'the-odds-api', %(snapshot_type)s, %(snapshot_ts)s
        )
    """, {
        "game_id":       game_id,
        "player_id":     payload.get("player_id"),
        "bookmaker":     bookmaker,
        "market_group":  market_group,
        "market_type":   market_type,
        "home_ml":       payload.get("home_ml"),
        "away_ml":       payload.get("away_ml"),
        "spread_line":   payload.get("spread_line"),
        "spread_home":   payload.get("spread_home"),
        "spread_away":   payload.get("spread_away"),
        "total_line":    payload.get("total_line"),
        "total_over":    payload.get("total_over"),
        "total_under":   payload.get("total_under"),
        "prop_line":     payload.get("prop_line"),
        "prop_over":     payload.get("prop_over"),
        "prop_under":    payload.get("prop_under"),
        "snapshot_type": snapshot_type,
        "snapshot_ts":   ts,
    })


# ── Game-level odds (h2h, spreads, totals) ────────────────────────────────────

def fetch_game_odds(snapshot_type: str = "pre_game"):
    """
    Pulls moneyline, spread, and total for all today's WNBA games.
    Writes into:
      - wnba_games        (upsert)
      - wnba_game_odds    (upsert latest)
      - wnba_odds_history (append always)
    """
    url = f"{ODDS_BASE}/sports/{WNBA_SPORT_KEY}/odds"
    params = {
        "apiKey":      ODDS_API_KEY,
        "regions":     WNBA_REGIONS,
        "markets":     ",".join(GAME_MARKETS),
        "oddsFormat":  "american",
        "dateFormat":  "iso",
    }
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    events = resp.json()

    conn = get_db()
    cur  = conn.cursor()
    now  = datetime.utcnow()
    today = date.today()
    rows = 0

    for event in events:
        game_id    = event["id"]
        home_team  = event["home_team"]
        away_team  = event["away_team"]

        _upsert_game(cur, event, today)

        for bookmaker in event.get("bookmakers", []):
            book_key = bookmaker["key"]

            for market in bookmaker.get("markets", []):
                mkey     = market["key"]
                outcomes = market["outcomes"]
                payload  = {}

                if mkey == "h2h":
                    payload["home_ml"] = next((o["price"] for o in outcomes if o["name"] == home_team), None)
                    payload["away_ml"] = next((o["price"] for o in outcomes if o["name"] == away_team), None)
                    cur.execute("""
                        INSERT INTO wnba_game_odds (
                            game_id, bookmaker, market, is_live,
                            home_moneyline, away_moneyline, odds_ts
                        ) VALUES (%s,%s,'moneyline',FALSE,%s,%s,%s)
                        ON CONFLICT (game_id, bookmaker, market, is_live)
                        DO UPDATE SET
                            home_moneyline = EXCLUDED.home_moneyline,
                            away_moneyline = EXCLUDED.away_moneyline,
                            odds_ts        = EXCLUDED.odds_ts
                    """, (game_id, book_key, payload["home_ml"], payload["away_ml"], now))

                elif mkey == "spreads":
                    home_out = next((o for o in outcomes if o["name"] == home_team), None)
                    away_out = next((o for o in outcomes if o["name"] == away_team), None)
                    payload.update({
                        "spread_line":  home_out["point"]  if home_out else None,
                        "spread_home":  home_out["price"]  if home_out else None,
                        "spread_away":  away_out["price"]  if away_out else None,
                    })
                    cur.execute("""
                        INSERT INTO wnba_game_odds (
                            game_id, bookmaker, market, is_live,
                            spread_line, spread_home_odds, spread_away_odds, odds_ts
                        ) VALUES (%s,%s,'spread',FALSE,%s,%s,%s,%s)
                        ON CONFLICT (game_id, bookmaker, market, is_live)
                        DO UPDATE SET
                            spread_line      = EXCLUDED.spread_line,
                            spread_home_odds = EXCLUDED.spread_home_odds,
                            spread_away_odds = EXCLUDED.spread_away_odds,
                            odds_ts          = EXCLUDED.odds_ts
                    """, (game_id, book_key,
                          payload["spread_line"], payload["spread_home"], payload["spread_away"], now))

                elif mkey == "totals":
                    over  = next((o for o in outcomes if o["name"] == "Over"),  None)
                    under = next((o for o in outcomes if o["name"] == "Under"), None)
                    payload.update({
                        "total_line":  over["point"]  if over  else None,
                        "total_over":  over["price"]  if over  else None,
                        "total_under": under["price"] if under else None,
                    })
                    cur.execute("""
                        INSERT INTO wnba_game_odds (
                            game_id, bookmaker, market, is_live,
                            total_line, total_over_odds, total_under_odds, odds_ts
                        ) VALUES (%s,%s,'totals',FALSE,%s,%s,%s,%s)
                        ON CONFLICT (game_id, bookmaker, market, is_live)
                        DO UPDATE SET
                            total_line       = EXCLUDED.total_line,
                            total_over_odds  = EXCLUDED.total_over_odds,
                            total_under_odds = EXCLUDED.total_under_odds,
                            odds_ts          = EXCLUDED.odds_ts
                    """, (game_id, book_key,
                          payload["total_line"], payload["total_over"], payload["total_under"], now))

                _insert_history(cur, game_id, book_key, "game", mkey, payload, snapshot_type, now)
                rows += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_game_odds [{snapshot_type}]: {rows} rows across {len(events)} games")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    fetch_game_odds(snapshot_type="pre_game")
