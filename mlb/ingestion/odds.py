import requests
import psycopg2
from datetime import datetime
from mlb.config import ODDS_BASE, ODDS_API_KEY, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.odds")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_odds(snapshot_type: str = "pre_game"):
    url = f"{ODDS_BASE}/sports/baseball_mlb/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": "us",
        "markets": "h2h,spreads,totals",
        "oddsFormat": "american",
        "dateFormat": "iso"
    }
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    events = resp.json()

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()
    rows_inserted = 0

    for event in events:
        event_id = event.get("id")
        home_team = event.get("home_team")
        away_team = event.get("away_team")
        commence = event.get("commence_time")

        cur.execute("""
            INSERT INTO game_id_map (odds_event_id, home_team, away_team, commence_time)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (odds_event_id) DO NOTHING
        """, (event_id, home_team, away_team, commence))

        for bookmaker in event.get("bookmakers", []):
            book_key = bookmaker.get("key")
            for market in bookmaker.get("markets", []):
                market_key = market.get("key")
                outcomes = market.get("outcomes", [])

                if market_key == "h2h":
                    home_odds = next((o["price"] for o in outcomes if o["name"] == home_team), None)
                    away_odds = next((o["price"] for o in outcomes if o["name"] == away_team), None)
                    cur.execute("""
                        INSERT INTO market_snapshots (
                            odds_event_id, market_type, bookmaker,
                            home_odds, away_odds, snapshot_type, snapshot_time
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s)
                    """, (event_id, "h2h", book_key, home_odds, away_odds, snapshot_type, now))

                elif market_key == "totals":
                    over = next((o for o in outcomes if o["name"] == "Over"), None)
                    under = next((o for o in outcomes if o["name"] == "Under"), None)
                    cur.execute("""
                        INSERT INTO market_snapshots (
                            odds_event_id, market_type, bookmaker,
                            line, over_odds, under_odds, snapshot_type, snapshot_time
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    """, (
                        event_id, "totals", book_key,
                        over["point"] if over else None,
                        over["price"] if over else None,
                        under["price"] if under else None,
                        snapshot_type, now
                    ))
                rows_inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_odds [{snapshot_type}]: {rows_inserted} rows for {len(events)} events")
