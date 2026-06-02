import requests
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.schedule")
ET = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_schedule(date: str = None):
    if not date:
        date = datetime.now(ET).strftime("%Y-%m-%d")

    url = f"{MLB_BASE}/schedule"
    params = {
        "sportId": 1,
        "date": date,
        "hydrate": "probablePitcher,weather,venue,linescore,team,status"
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    games = []
    for date_entry in data.get("dates", []):
        for game in date_entry.get("games", []):
            gk = game.get("gamePk")
            teams = game.get("teams", {})
            home = teams.get("home", {})
            away = teams.get("away", {})
            venue = game.get("venue", {})
            weather = game.get("weather", {})
            home_sp = home.get("probablePitcher", {})
            away_sp = away.get("probablePitcher", {})

            row = {
                "game_id": str(gk),
                "game_date": game.get("gameDate"),
                "venue_id": venue.get("id"),
                "venue_name": venue.get("name"),
                "home_team_id": home.get("team", {}).get("id"),
                "away_team_id": away.get("team", {}).get("id"),
                "home_sp_id": home_sp.get("id"),
                "away_sp_id": away_sp.get("id"),
                "sp_confirmed": bool(home_sp and away_sp),
                "weather_temp_f": float(weather["temp"]) if weather.get("temp") else None,
                "weather_conditions": weather.get("condition"),
                "last_updated": datetime.utcnow()
            }
            games.append(row)

    if not games:
        log.info(f"No games found for {date}")
        return

    conn = get_db()
    cur = conn.cursor()
    for row in games:
        cur.execute("""
            INSERT INTO game_context (
                game_id, game_date, venue_id, venue_name,
                home_team_id, away_team_id,
                home_sp_id, away_sp_id, sp_confirmed,
                weather_temp_f, weather_conditions, last_updated
            ) VALUES (
                %(game_id)s, %(game_date)s, %(venue_id)s, %(venue_name)s,
                %(home_team_id)s, %(away_team_id)s,
                %(home_sp_id)s, %(away_sp_id)s, %(sp_confirmed)s,
                %(weather_temp_f)s, %(weather_conditions)s, %(last_updated)s
            )
            ON CONFLICT (game_id) DO UPDATE SET
                sp_confirmed = EXCLUDED.sp_confirmed,
                home_sp_id = EXCLUDED.home_sp_id,
                away_sp_id = EXCLUDED.away_sp_id,
                weather_temp_f = EXCLUDED.weather_temp_f,
                weather_conditions = EXCLUDED.weather_conditions,
                last_updated = EXCLUDED.last_updated
        """, row)
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_schedule: upserted {len(games)} games for {date}")
