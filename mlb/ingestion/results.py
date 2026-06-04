"""results.py — Fetches and upserts final game results from MLB StatsAPI.

Runs nightly as startup step 15 (after all predictions are locked in).
Upserts into the `results` table, which is the ground-truth source for
run_calibration.py, CLV tracking, and model backfill.

Fields populated:
  home_runs, away_runs, home_sp_id, away_sp_id,
  home_sp_ks, away_sp_ks, home_sp_ip, away_sp_ip,
  game_total, result_fetched_at

Only fetches results for game_ids already in game_context that have
no entry in results (or were fetched >12h ago for in-progress games).
"""
import requests
import psycopg2
import psycopg2.extras
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.results")
ET  = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def _parse_ip(ip_str) -> float:
    """Convert '6.1' (6 full innings + 1 out) to decimal IP."""
    try:
        parts = str(ip_str).split(".")
        return int(parts[0]) + (int(parts[1]) / 3 if len(parts) > 1 and parts[1] else 0)
    except Exception:
        return 0.0

def fetch_results_for_date(date_str: str = None):
    """Fetch and upsert results for the given date (defaults to yesterday ET)."""
    if date_str is None:
        yesterday = (datetime.now(ET) - timedelta(days=1)).strftime("%Y-%m-%d")
        date_str  = yesterday

    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Find game_ids from game_context for this date that need results
    cur.execute("""
        SELECT gc.game_id, gc.home_team_id, gc.away_team_id,
               gc.home_sp_id, gc.away_sp_id
        FROM game_context gc
        LEFT JOIN results r ON gc.game_id = r.game_id
        WHERE DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s
          AND (
            r.game_id IS NULL
            OR r.result_fetched_at < NOW() - INTERVAL '12 hours'
          )
    """, (date_str,))
    games = cur.fetchall()

    if not games:
        log.info(f"fetch_results_for_date({date_str}): no games to fetch")
        cur.close()
        conn.close()
        return

    write_cur = conn.cursor()
    fetched   = 0

    for game in games:
        game_id = game["game_id"]
        try:
            resp = requests.get(
                f"{MLB_BASE}/game/{game_id}/linescore",
                timeout=10
            )
            resp.raise_for_status()
            ls = resp.json()

            # Score
            home_runs = ls.get("teams", {}).get("home", {}).get("runs")
            away_runs = ls.get("teams", {}).get("away", {}).get("runs")
            if home_runs is None or away_runs is None:
                log.info(f"fetch_results: {game_id} — no score yet, skipping")
                continue

            game_total = int(home_runs) + int(away_runs)

            # Pitcher stats (boxscore endpoint)
            box_resp = requests.get(
                f"{MLB_BASE}/game/{game_id}/boxscore",
                timeout=10
            )
            box_resp.raise_for_status()
            box = box_resp.json()

            def _sp_stats(side: str, sp_id: int):
                """Extract Ks and IP for a known SP id from boxscore."""
                pitchers = box.get("teams", {}).get(side, {}).get("pitchers", [])
                players  = box.get("teams", {}).get(side, {}).get("players", {})
                ks = ip = None
                for pid in pitchers:
                    p_key = f"ID{pid}"
                    p_data = players.get(p_key, {})
                    if p_data.get("person", {}).get("id") == sp_id:
                        stats = p_data.get("stats", {}).get("pitching", {})
                        ks = stats.get("strikeOuts")
                        ip = _parse_ip(stats.get("inningsPitched", "0"))
                        break
                return ks, ip

            home_sp_ks, home_sp_ip = _sp_stats("home", game["home_sp_id"])
            away_sp_ks, away_sp_ip = _sp_stats("away", game["away_sp_id"])

            write_cur.execute("""
                INSERT INTO results (
                    game_id, home_runs, away_runs,
                    home_sp_id, away_sp_id,
                    home_sp_ks, away_sp_ks,
                    home_sp_ip, away_sp_ip,
                    game_total, result_fetched_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (game_id) DO UPDATE SET
                    home_runs        = EXCLUDED.home_runs,
                    away_runs        = EXCLUDED.away_runs,
                    home_sp_ks       = EXCLUDED.home_sp_ks,
                    away_sp_ks       = EXCLUDED.away_sp_ks,
                    home_sp_ip       = EXCLUDED.home_sp_ip,
                    away_sp_ip       = EXCLUDED.away_sp_ip,
                    game_total       = EXCLUDED.game_total,
                    result_fetched_at = EXCLUDED.result_fetched_at
            """, (
                game_id, home_runs, away_runs,
                game["home_sp_id"], game["away_sp_id"],
                home_sp_ks, away_sp_ks,
                home_sp_ip, away_sp_ip,
                game_total, datetime.utcnow()
            ))
            fetched += 1
            log.info(f"fetch_results: {game_id} — {away_runs}@{home_runs} total={game_total}")

        except Exception as e:
            log.error(f"fetch_results: {game_id} — {e}")
            continue

    conn.commit()
    write_cur.close()
    cur.close()
    conn.close()
    log.info(f"fetch_results_for_date({date_str}): upserted {fetched} results")


def fetch_results_for_today():
    """Convenience wrapper — fetches yesterday's results at startup."""
    from datetime import timedelta
    yesterday = (datetime.now(ET) - timedelta(days=1)).strftime("%Y-%m-%d")
    fetch_results_for_date(yesterday)
