import requests
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.results")
ET = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_results(date: str = None):
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

    inserted = 0
    for game_id in game_ids:
        try:
            url = f"{MLB_BASE}/game/{game_id}/boxscore"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            teams = data.get("teams", {})
            home = teams.get("home", {})
            away = teams.get("away", {})

            home_runs = home.get("teamStats", {}).get("batting", {}).get("runs")
            away_runs = away.get("teamStats", {}).get("batting", {}).get("runs")

            def get_sp_stats(team, pitchers):
                if not pitchers:
                    return None, None, None
                sp_key = pitchers[0]
                sp = team.get("players", {}).get(f"ID{sp_key}", {})
                stats = sp.get("stats", {}).get("pitching", {})
                ks = stats.get("strikeOuts", 0)
                ip_str = stats.get("inningsPitched", "0.0")
                parts = str(ip_str).split(".")
                ip = int(parts[0]) + (int(parts[1]) / 3 if len(parts) > 1 and parts[1] else 0)
                return sp_key, ks, ip

            home_sp_id, home_sp_ks, home_sp_ip = get_sp_stats(home, home.get("pitchers", []))
            away_sp_id, away_sp_ks, away_sp_ip = get_sp_stats(away, away.get("pitchers", []))

            cur = conn.cursor()
            cur.execute("""
                INSERT INTO results (
                    game_id, home_runs, away_runs,
                    home_sp_id, away_sp_id,
                    home_sp_ks, away_sp_ks,
                    home_sp_ip, away_sp_ip,
                    game_total, result_fetched_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (game_id) DO UPDATE SET
                    home_runs=EXCLUDED.home_runs, away_runs=EXCLUDED.away_runs,
                    home_sp_ks=EXCLUDED.home_sp_ks, away_sp_ks=EXCLUDED.away_sp_ks,
                    home_sp_ip=EXCLUDED.home_sp_ip, away_sp_ip=EXCLUDED.away_sp_ip,
                    game_total=EXCLUDED.game_total,
                    result_fetched_at=EXCLUDED.result_fetched_at
            """, (
                game_id, home_runs, away_runs,
                home_sp_id, away_sp_id,
                home_sp_ks, away_sp_ks,
                home_sp_ip, away_sp_ip,
                (home_runs or 0) + (away_runs or 0),
                datetime.utcnow()
            ))
            conn.commit()
            cur.close()
            inserted += 1
        except Exception as e:
            log.error(f"fetch_results: game {game_id}: {e}")

    conn.close()
    log.info(f"fetch_results: stored {inserted} games for {date}")
