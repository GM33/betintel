import requests
import psycopg2
from datetime import datetime, date
from wnba.config import ODDS_BASE, ODDS_API_KEY, DATABASE_URL, WNBA_SPORT_KEY, WNBA_REGIONS
import logging

log = logging.getLogger("betintel.wnba.ingestion.props")

# The Odds API market keys for WNBA player props
PROP_MARKETS = [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds_assists",
    "player_threes",
]

# Map API market key → our internal prop_type label
MARKET_TO_PROP = {
    "player_points":                    "points",
    "player_rebounds":                  "rebounds",
    "player_assists":                   "assists",
    "player_points_rebounds_assists":   "pra",
    "player_threes":                    "threes",
}


def get_db():
    return psycopg2.connect(DATABASE_URL)


def _resolve_player_id(cur, player_name: str) -> int | None:
    """Look up player_id from wnba_players by full_name."""
    cur.execute(
        "SELECT player_id FROM wnba_players WHERE full_name = %s LIMIT 1",
        (player_name,)
    )
    row = cur.fetchone()
    return row[0] if row else None


def fetch_props(snapshot_type: str = "pre_game"):
    """
    For each WNBA event today:
      1. Fetch each prop market one at a time (The Odds API requires per-market calls for props).
      2. Upsert into wnba_player_props (latest line).
      3. Append to wnba_odds_history (full movement record).

    Skips players not yet in wnba_players (player_id = NULL rows are not inserted).
    """
    # Step 1: get today's event IDs
    events_url = f"{ODDS_BASE}/sports/{WNBA_SPORT_KEY}/events"
    events_resp = requests.get(events_url, params={
        "apiKey": ODDS_API_KEY,
        "dateFormat": "iso",
    }, timeout=15)
    events_resp.raise_for_status()
    events = events_resp.json()

    conn = get_db()
    cur  = conn.cursor()
    now  = datetime.utcnow()
    total_rows = 0

    for event in events:
        game_id   = event["id"]
        home_team = event["home_team"]
        away_team = event["away_team"]

        # Check game exists in wnba_games (ingested by odds.py first)
        cur.execute("SELECT 1 FROM wnba_games WHERE game_id = %s", (game_id,))
        if not cur.fetchone():
            log.warning(f"Game {game_id} not in wnba_games — run fetch_game_odds first")
            continue

        # Step 2: pull each prop market separately
        for market_key in PROP_MARKETS:
            prop_url = f"{ODDS_BASE}/sports/{WNBA_SPORT_KEY}/events/{game_id}/odds"
            resp = requests.get(prop_url, params={
                "apiKey":     ODDS_API_KEY,
                "regions":    WNBA_REGIONS,
                "markets":    market_key,
                "oddsFormat": "american",
                "dateFormat": "iso",
            }, timeout=15)

            if resp.status_code == 422:
                # Market not available for this event
                log.debug(f"Market {market_key} unavailable for {game_id}")
                continue
            resp.raise_for_status()

            data      = resp.json()
            prop_type = MARKET_TO_PROP[market_key]

            for bookmaker in data.get("bookmakers", []):
                book_key = bookmaker["key"]

                for market in bookmaker.get("markets", []):
                    outcomes = market.get("outcomes", [])

                    # Group outcomes by player name
                    players: dict[str, dict] = {}
                    for o in outcomes:
                        name = o["description"]  # The Odds API uses 'description' for player name
                        if name not in players:
                            players[name] = {}
                        if o["name"] == "Over":
                            players[name]["line"]      = o.get("point")
                            players[name]["over_odds"] = o["price"]
                        elif o["name"] == "Under":
                            players[name]["under_odds"] = o["price"]

                    for player_name, vals in players.items():
                        if not vals.get("line") or not vals.get("over_odds") or not vals.get("under_odds"):
                            continue

                        player_id = _resolve_player_id(cur, player_name)
                        if player_id is None:
                            log.debug(f"Unknown player '{player_name}' — skipping")
                            continue

                        # Upsert latest prop line
                        cur.execute("""
                            INSERT INTO wnba_player_props (
                                game_id, player_id, bookmaker, prop_type, is_live,
                                line, over_odds, under_odds, odds_ts
                            ) VALUES (%s,%s,%s,%s,FALSE,%s,%s,%s,%s)
                            ON CONFLICT (game_id, player_id, bookmaker, prop_type, is_live)
                            DO UPDATE SET
                                line       = EXCLUDED.line,
                                over_odds  = EXCLUDED.over_odds,
                                under_odds = EXCLUDED.under_odds,
                                odds_ts    = EXCLUDED.odds_ts
                        """, (
                            game_id, player_id, book_key, prop_type,
                            vals["line"], vals["over_odds"], vals["under_odds"], now
                        ))

                        # Append to history
                        cur.execute("""
                            INSERT INTO wnba_odds_history (
                                game_id, player_id, bookmaker,
                                market_group, market_type, is_live,
                                prop_line, prop_over_odds, prop_under_odds,
                                snapshot_source, snapshot_type, snapshot_ts
                            ) VALUES (%s,%s,%s,'player_prop',%s,FALSE,%s,%s,%s,'the-odds-api',%s,%s)
                        """, (
                            game_id, player_id, book_key, prop_type,
                            vals["line"], vals["over_odds"], vals["under_odds"],
                            snapshot_type, now
                        ))
                        total_rows += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_props [{snapshot_type}]: {total_rows} prop rows inserted")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    fetch_props(snapshot_type="pre_game")
