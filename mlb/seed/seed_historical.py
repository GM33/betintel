"""Seeds pitcher_k_games and game_run_data from MLB StatsAPI public endpoints.
No CSV upload needed. Pulls 2022-2025 SP game logs directly.
"""
import requests
import psycopg2
import logging
from datetime import datetime, date, timedelta
from mlb.config import MLB_BASE, DATABASE_URL

log = logging.getLogger("betintel.seed")

SEED_SEASONS = [2022, 2023, 2024, 2025]

def get_db():
    return psycopg2.connect(DATABASE_URL)

def get_all_team_ids():
    resp = requests.get(f"{MLB_BASE}/teams", params={"sportId": 1}, timeout=10)
    resp.raise_for_status()
    return [(t["id"], t["name"]) for t in resp.json().get("teams", [])]

def get_sp_game_logs(pitcher_id: int, season: int):
    url = f"{MLB_BASE}/people/{pitcher_id}/stats"
    params = {
        "stats": "gameLog",
        "group": "pitching",
        "season": season,
        "sportId": 1
    }
    resp = requests.get(url, params=params, timeout=10)
    if resp.status_code != 200:
        return []
    splits = resp.json().get("stats", [{}])[0].get("splits", [])
    return splits

def get_season_sp_ids(season: int):
    """Get all pitchers who made SP appearances that season."""
    url = f"{MLB_BASE}/stats"
    params = {
        "stats": "season",
        "group": "pitching",
        "season": season,
        "sportId": 1,
        "limit": 500,
        "startsPitching": 1
    }
    resp = requests.get(url, params=params, timeout=15)
    if resp.status_code != 200:
        return []
    splits = resp.json().get("stats", [{}])[0].get("splits", [])
    return [(s["player"]["id"], s["player"]["fullName"]) for s in splits if s.get("stat", {}).get("gamesStarted", 0) >= 5]

def upsert_pitcher_stat(conn, pitcher_id: int, name: str, stat: dict, hand: str):
    cur = conn.cursor()
    ip_str = stat.get("inningsPitched", "0.0")
    parts = str(ip_str).split(".")
    ip = int(parts[0]) + (int(parts[1]) / 3 if len(parts) > 1 and parts[1] else 0)
    games_started = stat.get("gamesStarted", 0)
    if games_started == 0:
        cur.close()
        return
    k_total = stat.get("strikeOuts", 0)
    bb_total = stat.get("baseOnBalls", 0)
    ip_total = ip
    k_rate = k_total / max(ip_total * 3, 1)  # K per out
    bb_rate = bb_total / max(ip_total * 3, 1)
    ip_per_start = ip_total / max(games_started, 1)
    p_hand = 1 if hand == "R" else 0

    cur.execute("""
        INSERT INTO pitcher_stats (
            pitcher_id, pitcher_name, season,
            p_k_rate, p_k_rate_vs_hand, p_bb_rate,
            p_swstr_rate, p_ip_per_start, p_hand, last_updated
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (pitcher_id, season) DO UPDATE SET
            p_k_rate = EXCLUDED.p_k_rate,
            p_bb_rate = EXCLUDED.p_bb_rate,
            p_ip_per_start = EXCLUDED.p_ip_per_start,
            last_updated = EXCLUDED.last_updated
    """, (
        pitcher_id, name, 0,  # season=0 means current rolling
        round(k_rate, 4), round(k_rate, 4), round(bb_rate, 4),
        None, round(ip_per_start, 2), p_hand, datetime.utcnow()
    ))
    conn.commit()
    cur.close()

def seed_pitcher_k_games_for_season(season: int):
    log.info(f"Seeding K game logs for season {season}...")
    sp_ids = get_season_sp_ids(season)
    log.info(f"  Found {len(sp_ids)} SPs for {season}")
    conn = get_db()
    inserted = 0

    for pitcher_id, name in sp_ids:
        try:
            # Get pitcher handedness
            pinfo = requests.get(f"{MLB_BASE}/people/{pitcher_id}", timeout=8).json()
            hand = pinfo.get("people", [{}])[0].get("pitchHand", {}).get("code", "R")
            p_hand = 1 if hand == "R" else 0

            splits = get_sp_game_logs(pitcher_id, season)
            for split in splits:
                stat = split.get("stat", {})
                game = split.get("game", {})
                team = split.get("team", {})
                opp = split.get("opponent", {})
                date_str = split.get("date", "")
                if not date_str or not stat.get("gamesStarted", 0):
                    continue

                ip_str = stat.get("inningsPitched", "0.0")
                parts = str(ip_str).split(".")
                ip = int(parts[0]) + (int(parts[1]) / 3 if len(parts) > 1 and parts[1] else 0)
                if ip < 1:
                    continue  # skip relief appearances

                k_outs = stat.get("strikeOuts", 0)
                bb = stat.get("baseOnBalls", 0)
                k_rate = k_outs / max(ip * 3, 1)
                bb_rate = bb / max(ip * 3, 1)
                home_away = 0 if split.get("isHome") == False else 1

                cur = conn.cursor()
                cur.execute("""
                    INSERT INTO pitcher_k_games (
                        game_id, date, pitcher_id, team_id, opp_team_id,
                        home_away, k_outs,
                        p_k_rate, p_k_rate_vs_hand, p_bb_rate,
                        p_ip_per_start, p_hand,
                        g_park_id, created_at
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT DO NOTHING
                """, (
                    str(game.get("gamePk", f"{pitcher_id}_{date_str}")),
                    date_str,
                    pitcher_id,
                    team.get("id"), opp.get("id"),
                    home_away, k_outs,
                    round(k_rate, 4), round(k_rate, 4), round(bb_rate, 4),
                    round(ip, 2), p_hand,
                    str(team.get("id")),
                    datetime.utcnow()
                ))
                conn.commit()
                cur.close()
                inserted += 1
        except Exception as e:
            log.warning(f"  Skipped pitcher {pitcher_id} ({name}): {e}")
            continue

    conn.close()
    log.info(f"  Seeded {inserted} K game rows for {season}")

def seed_game_run_data_for_season(season: int):
    log.info(f"Seeding run data for season {season}...")
    team_ids = get_all_team_ids()
    conn = get_db()
    inserted = 0

    for team_id, team_name in team_ids:
        try:
            url = f"{MLB_BASE}/schedule"
            params = {
                "sportId": 1,
                "teamId": team_id,
                "season": season,
                "gameType": "R",
                "hydrate": "linescore,team,probablePitcher"
            }
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            dates = resp.json().get("dates", [])

            for date_entry in dates:
                for game in date_entry.get("games", []):
                    if game.get("status", {}).get("abstractGameState") != "Final":
                        continue
                    gk = str(game.get("gamePk"))
                    game_date = date_entry.get("date")
                    teams = game.get("teams", {})
                    home = teams.get("home", {})
                    away = teams.get("away", {})
                    home_runs = home.get("score")
                    away_runs = away.get("score")
                    if home_runs is None or away_runs is None:
                        continue

                    is_home = 1 if home.get("team", {}).get("id") == team_id else 0
                    runs_scored = home_runs if is_home else away_runs
                    opp_sp = (away if is_home else home).get("probablePitcher", {})

                    cur = conn.cursor()
                    cur.execute("""
                        INSERT INTO game_run_data (
                            game_id, team_id, is_home, date,
                            runs_scored,
                            opp_sp_xfip, opp_bp_ip_last_3d,
                            created_at
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT DO NOTHING
                    """, (
                        gk, team_id, is_home, game_date,
                        runs_scored,
                        None, None,
                        datetime.utcnow()
                    ))
                    conn.commit()
                    cur.close()
                    inserted += 1
        except Exception as e:
            log.warning(f"  Skipped team {team_id} ({team_name}): {e}")
            continue

    conn.close()
    log.info(f"  Seeded {inserted} run data rows for {season}")

def seed_all():
    # Create supporting tables if not exists
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pitcher_stats (
            pitcher_id INT,
            season INT,
            pitcher_name VARCHAR,
            p_k_rate FLOAT,
            p_k_rate_vs_hand FLOAT,
            p_bb_rate FLOAT,
            p_swstr_rate FLOAT,
            p_ip_per_start FLOAT,
            p_hand INT,
            last_updated TIMESTAMPTZ,
            PRIMARY KEY (pitcher_id, season)
        );
        CREATE TABLE IF NOT EXISTS team_offense_stats (
            team_id INT PRIMARY KEY,
            k_rate_vs_rh FLOAT,
            k_rate_vs_lh FLOAT,
            wrc_plus_vs_rh FLOAT,
            wrc_plus_vs_lh FLOAT,
            obp_vs_rh FLOAT,
            obp_vs_lh FLOAT,
            last_updated TIMESTAMPTZ
        );
    """)
    conn.commit()
    cur.close()
    conn.close()

    for season in SEED_SEASONS:
        seed_pitcher_k_games_for_season(season)
        seed_game_run_data_for_season(season)

    log.info("\n✅ Historical seed complete across all seasons.")
