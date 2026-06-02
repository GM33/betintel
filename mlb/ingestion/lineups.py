import requests
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from config import MLB_BASE, DATABASE_URL
import logging

ET = ZoneInfo("America/New_York")
log = logging.getLogger("betintel.ingestion.lineups")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_lineups(date: str = None):
    """
    Fetch confirmed batting lineups for all games on a given date.
    Run 3 hours before first pitch and again 1 hour before.
    """
    if not date:
        date = datetime.now(ET).strftime("%Y-%m-%d")

    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT game_id FROM game_context
        WHERE DATE(game_date AT TIME ZONE 'America/New_York') = %s
    """, (date,))
    game_ids = [row[0] for row in cur.fetchall()]
    cur.close()
    conn.close()

    if not game_ids:
        log.info("fetch_lineups: no games found in DB for date")
        return

    for game_id in game_ids:
        try:
            url = f"https://statsapi.mlb.com/api/v1.1/game/{game_id}/feed/live"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            live = data.get("liveData", {})
            boxscore = live.get("boxscore", {})
            teams = boxscore.get("teams", {})
            status = data.get("gameData", {}).get("status", {}).get("detailedState", "")

            home_lineup = teams.get("home", {}).get("battingOrder", [])
            away_lineup = teams.get("away", {}).get("battingOrder", [])

            lineup_confirmed = status in ("Pre-Game", "Warmup", "In Progress", "Final")

            conn = get_db()
            cur = conn.cursor()
            cur.execute("""
                UPDATE game_context SET
                    home_lineup = %s,
                    away_lineup = %s,
                    lineup_confirmed = %s,
                    last_updated = %s
                WHERE game_id = %s
            """, (
                home_lineup,
                away_lineup,
                lineup_confirmed,
                datetime.utcnow(),
                game_id
            ))
            conn.commit()
            cur.close()
            conn.close()
            log.info(f"fetch_lineups: updated game {game_id}, confirmed={lineup_confirmed}")

        except Exception as e:
            log.error(f"fetch_lineups: failed for game {game_id}: {e}")
