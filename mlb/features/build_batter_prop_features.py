"""build_batter_prop_features.py

Builds per-batter feature rows for hits and total bases prop models.
Mirrors build_k_features.py pattern exactly.

Sources:
  - game_context      : game metadata, confirmed lineups, SP IDs
  - pitcher_stats     : opp SP ERA/xERA/FIP/SwStr% (Rank 1 data)
  - game_run_data     : wind direction, park factor
  - MLB StatsAPI      : batter season + rolling splits, batting order
  - results           : actual_hits/actual_tb (backfill after game)

Runs as startup step 6.5 (after lineups + pitcher_stats, before training).
"""
import requests
import psycopg2
import psycopg2.extras
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL

log = logging.getLogger("betintel.features.batter_props")
ET  = ZoneInfo("America/New_York")

# Park HR factors (2026 approximations — update annually)
PARK_HR_FACTOR = {
    "Coors Field": 1.38, "Great American Ball Park": 1.24,
    "Fenway Park": 1.18, "Yankee Stadium": 1.15,
    "Citizens Bank Park": 1.12, "Minute Maid Park": 1.08,
    "Truist Park": 1.06, "Wrigley Field": 1.05,
    "Oracle Park": 0.82, "Petco Park": 0.84,
    "T-Mobile Park": 0.81, "Dodger Stadium": 0.94,
}

DEFAULT_HR_FACTOR = 1.00

def get_db():
    return psycopg2.connect(DATABASE_URL)

def _safe_float(val):
    try:
        return float(val) if val not in (None, "", "null") else None
    except (ValueError, TypeError):
        return None

def _fetch_batter_season_stats(player_id: int, season: int) -> dict:
    """Pull season-level batting splits from MLB StatsAPI."""
    try:
        resp = requests.get(
            f"{MLB_BASE}/people/{player_id}",
            params={"hydrate": f"stats(group=hitting,type=season,season={season})"},
            timeout=10
        )
        resp.raise_for_status()
        people = resp.json().get("people", [])
        if not people:
            return {}
        stats_groups = people[0].get("stats", [])
        if not stats_groups:
            return {}
        splits = stats_groups[0].get("splits", [])
        if not splits:
            return {}
        s = splits[0].get("stat", {})
        return {
            "hits_season_avg": _safe_float(s.get("avg")),
            "tb_season_avg":   _safe_float(s.get("slg")),   # SLG as TB proxy
            "obp_vs_hand":     _safe_float(s.get("obp")),
            "slg_vs_hand":     _safe_float(s.get("slg")),
            "batter_hand":     1 if people[0].get("batSide", {}).get("code") == "R" else 0,
        }
    except Exception as e:
        log.warning(f"_fetch_batter_season_stats {player_id}: {e}")
        return {}

def _fetch_batter_rolling(player_id: int, season: int, last_n: int) -> dict:
    """Pull last-N game log from MLB StatsAPI to compute rolling H/g and TB/g."""
    try:
        resp = requests.get(
            f"{MLB_BASE}/people/{player_id}",
            params={"hydrate": f"stats(group=hitting,type=gameLog,season={season})"},
            timeout=10
        )
        resp.raise_for_status()
        people = resp.json().get("people", [])
        if not people:
            return {}
        splits = []
        for sg in people[0].get("stats", []):
            splits.extend(sg.get("splits", []))
        # Sort by date descending, take last_n
        splits = sorted(splits, key=lambda x: x.get("date", ""), reverse=True)[:last_n]
        if not splits:
            return {}
        hits_list = []
        tb_list   = []
        for sp in splits:
            s = sp.get("stat", {})
            h  = _safe_float(s.get("hits"))
            tb = _safe_float(s.get("totalBases"))
            if h  is not None: hits_list.append(h)
            if tb is not None: tb_list.append(tb)
        return {
            f"hits_last_{last_n}g": round(sum(hits_list) / len(hits_list), 4) if hits_list else None,
            f"tb_last_{last_n}g":   round(sum(tb_list)   / len(tb_list),   4) if tb_list   else None,
        }
    except Exception as e:
        log.warning(f"_fetch_batter_rolling {player_id} last{last_n}: {e}")
        return {}

def build_batter_prop_features_for_date(date: str):
    """Build and upsert batter_prop_features rows for all confirmed lineups on date."""
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    season = int(date[:4])

    # Get all confirmed games for date
    cur.execute("""
        SELECT gc.game_id, gc.home_team_id, gc.away_team_id,
               gc.home_sp_id, gc.away_sp_id,
               gc.home_lineup, gc.away_lineup,
               gc.venue_name,
               grd.park_runs_factor, grd.wind_out_speed, grd.wind_in_speed,
               grd.temp_f
        FROM game_context gc
        LEFT JOIN LATERAL (
            SELECT park_runs_factor, wind_out_speed, wind_in_speed, temp_f
            FROM game_run_data
            WHERE game_id = gc.game_id
            ORDER BY created_at DESC LIMIT 1
        ) grd ON TRUE
        WHERE DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s
          AND gc.lineup_confirmed = TRUE
    """, (date,))
    games = cur.fetchall()

    if not games:
        log.info(f"build_batter_prop_features: no confirmed lineups for {date}")
        cur.close()
        conn.close()
        return

    write_cur = conn.cursor()
    written   = 0

    for game in games:
        game_id    = game["game_id"]
        venue      = game["venue_name"] or ""
        park_rf    = game["park_runs_factor"] or 1.00
        park_hrf   = PARK_HR_FACTOR.get(venue, DEFAULT_HR_FACTOR)
        wind_out   = game["wind_out_speed"]
        wind_in    = game["wind_in_speed"]
        temp_f     = game["temp_f"]

        sides = [
            ("home", game["home_lineup"] or [], game["home_team_id"], game["away_sp_id"], 1),
            ("away", game["away_lineup"] or [], game["away_team_id"], game["home_sp_id"], 0),
        ]

        for side, lineup, team_id, opp_sp_id, is_home in sides:
            # Fetch opposing SP stats (Rank 1 data feeds directly here)
            opp_sp = {}
            if opp_sp_id:
                cur.execute("""
                    SELECT p_era, p_xera, p_fip, era_xera_gap,
                           p_swstr_rate, p_k_rate, p_bb_rate, p_gb_rate, p_hand
                    FROM pitcher_stats
                    WHERE pitcher_id = %s AND season = %s
                """, (opp_sp_id, season))
                row = cur.fetchone()
                if row:
                    opp_sp = dict(row)

            for order_idx, player_id in enumerate(lineup, start=1):
                if not player_id:
                    continue

                # Season stats
                season_stats = _fetch_batter_season_stats(player_id, season)
                # Rolling 7g
                roll_7  = _fetch_batter_rolling(player_id, season, 7)
                # Rolling 15g
                roll_15 = _fetch_batter_rolling(player_id, season, 15)

                sp_hand = opp_sp.get("p_hand")

                try:
                    write_cur.execute("""
                        INSERT INTO batter_prop_features (
                            game_id, player_id, team_id, is_home,
                            batting_order, date, season,
                            hits_last_7g, hits_last_15g, hits_season_avg,
                            tb_last_7g, tb_last_15g, tb_season_avg,
                            batter_hand, sp_hand,
                            avg_vs_hand, slg_vs_hand, obp_vs_hand,
                            opp_sp_era, opp_sp_xera, opp_sp_fip, opp_sp_era_xera_gap,
                            opp_sp_swstr_rate, opp_sp_k_rate, opp_sp_bb_rate, opp_sp_gb_rate,
                            park_runs_factor, park_hr_factor,
                            temp_f, wind_out_speed, wind_in_speed,
                            created_at
                        ) VALUES (
                            %s,%s,%s,%s,
                            %s,%s,%s,
                            %s,%s,%s,
                            %s,%s,%s,
                            %s,%s,
                            %s,%s,%s,
                            %s,%s,%s,%s,
                            %s,%s,%s,%s,
                            %s,%s,
                            %s,%s,%s,
                            %s
                        )
                        ON CONFLICT (game_id, player_id) DO UPDATE SET
                            hits_last_7g          = EXCLUDED.hits_last_7g,
                            hits_last_15g         = EXCLUDED.hits_last_15g,
                            hits_season_avg       = EXCLUDED.hits_season_avg,
                            tb_last_7g            = EXCLUDED.tb_last_7g,
                            tb_last_15g           = EXCLUDED.tb_last_15g,
                            tb_season_avg         = EXCLUDED.tb_season_avg,
                            batter_hand           = EXCLUDED.batter_hand,
                            sp_hand               = EXCLUDED.sp_hand,
                            avg_vs_hand           = EXCLUDED.avg_vs_hand,
                            slg_vs_hand           = EXCLUDED.slg_vs_hand,
                            obp_vs_hand           = EXCLUDED.obp_vs_hand,
                            opp_sp_era            = EXCLUDED.opp_sp_era,
                            opp_sp_xera           = EXCLUDED.opp_sp_xera,
                            opp_sp_fip            = EXCLUDED.opp_sp_fip,
                            opp_sp_era_xera_gap   = EXCLUDED.opp_sp_era_xera_gap,
                            opp_sp_swstr_rate     = EXCLUDED.opp_sp_swstr_rate,
                            opp_sp_k_rate         = EXCLUDED.opp_sp_k_rate,
                            opp_sp_bb_rate        = EXCLUDED.opp_sp_bb_rate,
                            opp_sp_gb_rate        = EXCLUDED.opp_sp_gb_rate,
                            park_runs_factor      = EXCLUDED.park_runs_factor,
                            park_hr_factor        = EXCLUDED.park_hr_factor,
                            temp_f                = EXCLUDED.temp_f,
                            wind_out_speed        = EXCLUDED.wind_out_speed,
                            wind_in_speed         = EXCLUDED.wind_in_speed,
                            created_at            = EXCLUDED.created_at
                    """, (
                        game_id, player_id, team_id, is_home,
                        order_idx, date, season,
                        roll_7.get("hits_last_7g"),
                        roll_15.get("hits_last_15g"),
                        season_stats.get("hits_season_avg"),
                        roll_7.get("tb_last_7g"),
                        roll_15.get("tb_last_15g"),
                        season_stats.get("tb_season_avg"),
                        season_stats.get("batter_hand"),
                        sp_hand,
                        season_stats.get("hits_season_avg"),
                        season_stats.get("slg_vs_hand"),
                        season_stats.get("obp_vs_hand"),
                        opp_sp.get("p_era"),
                        opp_sp.get("p_xera"),
                        opp_sp.get("p_fip"),
                        opp_sp.get("era_xera_gap"),
                        opp_sp.get("p_swstr_rate"),
                        opp_sp.get("p_k_rate"),
                        opp_sp.get("p_bb_rate"),
                        opp_sp.get("p_gb_rate"),
                        park_rf, park_hrf,
                        temp_f, wind_out, wind_in,
                        datetime.utcnow()
                    ))
                    written += 1
                except Exception as e:
                    log.error(f"batter_prop_features: game {game_id} player {player_id}: {e}")
                    conn.rollback()
                    continue

    conn.commit()
    write_cur.close()
    cur.close()
    conn.close()
    log.info(f"build_batter_prop_features: upserted {written} batter rows for {date}")
