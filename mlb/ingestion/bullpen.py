import requests
import psycopg2
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from config import MLB_BASE, DATABASE_URL
import logging

ET = ZoneInfo("America/New_York")
log = logging.getLogger("betintel.ingestion.bullpen")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_bullpen_usage():
    """
    Compute bullpen IP and reliever usage over last 1 and 3 days for all active teams.
    """
    today = datetime.now(ET).date()
    cutoff_1d = today - timedelta(days=1)
    cutoff_3d = today - timedelta(days=3)
    season = today.year

    teams_resp = requests.get(f"{MLB_BASE}/teams", params={"sportId": 1}, timeout=10)
    teams_resp.raise_for_status()
    team_ids = [t["id"] for t in teams_resp.json().get("teams", [])]

    conn = get_db()
    cur = conn.cursor()

    for team_id in team_ids:
        try:
            url = f"{MLB_BASE}/teams/{team_id}/roster"
            params = {
                "rosterType": "active",
                "hydrate": f"stats(group=pitching,type=gameLog,season={season})"
            }
            resp = requests.get(url, params=params, timeout=10)
            resp.raise_for_status()
            roster = resp.json().get("roster", [])

            bp_ip_1d = 0.0
            bp_ip_3d = 0.0
            bp_used_1d = 0
            bp_used_3d = 0

            for player in roster:
                position = player.get("position", {}).get("abbreviation", "")
                if position in ("SP",):
                    continue

                stats_list = player.get("person", {}).get("stats", [])
                for stat_group in stats_list:
                    for split in stat_group.get("splits", []):
                        game_date_str = split.get("date", "")
                        if not game_date_str:
                            continue
                        game_date = datetime.strptime(game_date_str, "%Y-%m-%d").date()
                        ip_str = split.get("stat", {}).get("inningsPitched", "0.0")
                        ip_parts = str(ip_str).split(".")
                        ip = int(ip_parts[0]) + (int(ip_parts[1]) / 3 if len(ip_parts) > 1 else 0)

                        if game_date >= cutoff_1d:
                            bp_ip_1d += ip
                            bp_used_1d += 1
                        if game_date >= cutoff_3d:
                            bp_ip_3d += ip
                            bp_used_3d += 1

            cur.execute("""
                INSERT INTO bullpen_stats (
                    team_id, date,
                    bp_ip_last_1d, bp_ip_last_3d,
                    bp_relievers_used_last_1d, bp_relievers_used_last_3d,
                    created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (team_id, date) DO UPDATE SET
                    bp_ip_last_1d = EXCLUDED.bp_ip_last_1d,
                    bp_ip_last_3d = EXCLUDED.bp_ip_last_3d,
                    bp_relievers_used_last_1d = EXCLUDED.bp_relievers_used_last_1d,
                    bp_relievers_used_last_3d = EXCLUDED.bp_relievers_used_last_3d,
                    created_at = EXCLUDED.created_at
            """, (
                team_id, today,
                round(bp_ip_1d, 2), round(bp_ip_3d, 2),
                bp_used_1d, bp_used_3d,
                datetime.utcnow()
            ))

        except Exception as e:
            log.error(f"fetch_bullpen_usage: failed for team {team_id}: {e}")
