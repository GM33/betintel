import requests
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import ODDS_BASE, ODDS_API_KEY, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.props")
ET = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_player_props():
    conn = get_db()
    cur = conn.cursor()
    today = datetime.now(ET).strftime("%Y-%m-%d")
    cur.execute("""
        SELECT odds_event_id FROM game_id_map
        WHERE DATE(commence_time) = %s
    """, (today,))
    event_ids = [row[0] for row in cur.fetchall()]
    cur.close()
    conn.close()

    if not event_ids:
        log.info("fetch_player_props: no event IDs for today")
        return

    now = datetime.utcnow()
    rows_inserted = 0
    conn = get_db()
    cur = conn.cursor()

    for event_id in event_ids:
        try:
            url = f"{ODDS_BASE}/sports/baseball_mlb/events/{event_id}/odds"
            params = {
                "apiKey": ODDS_API_KEY,
                "regions": "us",
                "markets": "pitcher_strikeouts",
                "oddsFormat": "american"
            }
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()

            for bookmaker in data.get("bookmakers", []):
                book_key = bookmaker.get("key")
                for market in bookmaker.get("markets", []):
                    if market.get("key") != "pitcher_strikeouts":
                        continue
                    pitchers = {}
                    for o in market.get("outcomes", []):
                        name = o.get("description")
                        side = o.get("name")
                        if name not in pitchers:
                            pitchers[name] = {}
                        pitchers[name][side] = {"price": o.get("price"), "point": o.get("point")}

                    for pitcher_name, sides in pitchers.items():
                        over = sides.get("Over", {})
                        under = sides.get("Under", {})
                        line = over.get("point") or under.get("point")
                        cur.execute("""
                            INSERT INTO market_snapshots (
                                odds_event_id, market_type, prop_type,
                                bookmaker, player_name,
                                line, over_odds, under_odds,
                                snapshot_type, snapshot_time
                            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """, (
                            event_id, "player_prop", "k_strikeouts",
                            book_key, pitcher_name,
                            line, over.get("price"), under.get("price"),
                            "pre_game", now
                        ))
                        rows_inserted += 1
        except Exception as e:
            log.error(f"fetch_player_props: event {event_id}: {e}")

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_player_props: {rows_inserted} prop rows inserted")
