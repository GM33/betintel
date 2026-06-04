"""build_run_features.py

Computes and upserts enriched run-scoring features into game_run_data for a given date.
Runs after game_context + results are populated. Adds:
  - Rolling 7d and 10-game SLG (team_slg_last_7d, team_slg_last_10)
  - SLG variance signal (team_slg_variance = season_slg - last_10_slg)
  - away_slg_delta (away SLG - home SLG, stored per game row)
  - ERA/xERA/FIP gap columns for opposing SP (era_xera_gap, era_fip_gap)
  - Park-adjusted total (park_adj_total = raw_total * park_runs_factor)
  - Wind direction bucket (wind_out_speed, wind_in_speed interaction features)
"""
import psycopg2
import psycopg2.extras
from datetime import datetime
from mlb.config import DATABASE_URL
import logging
import math

log = logging.getLogger("betintel.features.run")

STADIUM_ORIENTATION = {
    "T-Mobile Park": 180,
    "Oracle Park": 270,
    "Wrigley Field": 90,
    "Coors Field": 180,
    "Minute Maid Park": None,   # dome
    "Tropicana Field": None,    # dome
    "American Family Field": None,  # retractable
    "loanDepot park": None,
    "Globe Life Field": None,
}

def _wind_components(wind_speed_mph: float, wind_dir_deg: float, venue_name: str):
    """Returns (wind_out_speed, wind_in_speed) for a given venue orientation."""
    if venue_name in STADIUM_ORIENTATION and STADIUM_ORIENTATION[venue_name] is None:
        return 0.0, 0.0  # indoor or retractable — no wind effect
    orientation = STADIUM_ORIENTATION.get(venue_name)
    if orientation is None or wind_speed_mph is None or wind_dir_deg is None:
        return 0.0, 0.0
    # Angle between wind and outfield direction
    angle_diff = abs(wind_dir_deg - orientation) % 360
    if angle_diff > 180:
        angle_diff = 360 - angle_diff
    # cos(0) = 1 = pure tailwind (out), cos(180) = -1 = pure headwind (in)
    component = math.cos(math.radians(angle_diff))
    wind_out = round(max(component, 0.0) * wind_speed_mph, 2)
    wind_in  = round(max(-component, 0.0) * wind_speed_mph, 2)
    return wind_out, wind_in

def get_db():
    return psycopg2.connect(DATABASE_URL)

def build_run_features_for_date(date: str):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT grd.id, grd.game_id, grd.team_id, grd.is_home,
               grd.park_runs_factor, grd.wind_speed_mph,
               gc.weather_wind_dir_deg, gc.venue_name,
               gc.home_team_id, gc.away_team_id,
               gc.home_sp_id, gc.away_sp_id
        FROM game_run_data grd
        JOIN game_context gc ON grd.game_id = gc.game_id
        WHERE DATE(grd.date) = %s
    """, (date,))
    rows = cur.fetchall()
    update_cur = conn.cursor()

    for row in rows:
        team_id = row["team_id"]
        is_home = row["is_home"]
        game_id = row["game_id"]
        opp_sp_id = row["away_sp_id"] if is_home else row["home_sp_id"]
        opp_team_id = row["away_team_id"] if is_home else row["home_team_id"]

        # ── Rolling SLG ────────────────────────────────────────────────────────
        cur.execute("""
            SELECT AVG(team_iso_vs_hand + team_obp_vs_hand) AS slg_proxy_season,
                   (SELECT AVG(team_iso_vs_hand + team_obp_vs_hand)
                    FROM (SELECT team_iso_vs_hand, team_obp_vs_hand
                          FROM game_run_data
                          WHERE team_id=%s AND date < %s
                          ORDER BY date DESC LIMIT 10) sub) AS slg_last_10,
                   (SELECT AVG(team_iso_vs_hand + team_obp_vs_hand)
                    FROM (SELECT team_iso_vs_hand, team_obp_vs_hand
                          FROM game_run_data
                          WHERE team_id=%s AND date < %s
                          ORDER BY date DESC LIMIT 7) sub) AS slg_last_7
            FROM game_run_data
            WHERE team_id=%s AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM %s::date)
        """, (team_id, date, team_id, date, team_id, date))
        slg_row = cur.fetchone()
        slg_season = float(slg_row["slg_proxy_season"] or 0)
        slg_last_10 = float(slg_row["slg_last_10"] or 0)
        slg_last_7  = float(slg_row["slg_last_7"] or 0)
        slg_variance = round(slg_season - slg_last_10, 4)

        # ── Opposing SP ERA/xERA/FIP gaps ──────────────────────────────────────
        era_xera_gap = None
        era_fip_gap  = None
        if opp_sp_id:
            cur.execute("""
                SELECT p_era, p_xera, p_fip, p_xfip
                FROM pitcher_stats WHERE pitcher_id=%s
                ORDER BY last_updated DESC LIMIT 1
            """, (opp_sp_id,))
            ps = cur.fetchone()
            if ps:
                p_era, p_xera, p_fip, p_xfip = ps["p_era"], ps["p_xera"], ps["p_fip"], ps["p_xfip"]
                if p_era is not None and p_xera is not None:
                    era_xera_gap = round(float(p_era) - float(p_xera), 3)
                if p_era is not None and p_fip is not None:
                    era_fip_gap = round(float(p_era) - float(p_fip), 3)

        # ── Wind direction interaction ──────────────────────────────────────────
        wind_out_speed, wind_in_speed = _wind_components(
            row.get("wind_speed_mph"),
            row.get("weather_wind_dir_deg"),
            row.get("venue_name", "")
        )

        # ── Park-adjusted total ─────────────────────────────────────────────────
        # Use raw model total from market_snapshots if available
        cur.execute("""
            SELECT line FROM market_snapshots
            WHERE game_id=%s AND market_type='totals'
            ORDER BY snapshot_time DESC LIMIT 1
        """, (game_id,))
        ms = cur.fetchone()
        park_factor = float(row.get("park_runs_factor") or 1.0)
        park_adj_total = None
        if ms and ms["line"]:
            park_adj_total = round(float(ms["line"]) * park_factor, 2)

        # ── Away SLG delta (away minus home) ───────────────────────────────────
        cur.execute("""
            SELECT AVG(team_iso_vs_hand + team_obp_vs_hand)
            FROM (SELECT team_iso_vs_hand, team_obp_vs_hand
                  FROM game_run_data
                  WHERE team_id=%s AND date < %s
                  ORDER BY date DESC LIMIT 10) sub
        """, (opp_team_id, date))
        opp_slg_row = cur.fetchone()
        opp_slg_last_10 = float(list(opp_slg_row)[0] or 0)
        away_slg_delta = round(opp_slg_last_10 - slg_last_10, 4) if not is_home else None

        update_cur.execute("""
            UPDATE game_run_data SET
                team_slg_last_7d   = %s,
                team_slg_last_10   = %s,
                team_slg_variance  = %s,
                era_xera_gap       = %s,
                era_fip_gap        = %s,
                wind_out_speed     = %s,
                wind_in_speed      = %s,
                park_adj_total     = %s,
                away_slg_delta     = %s
            WHERE id = %s
        """, (
            slg_last_7, slg_last_10, slg_variance,
            era_xera_gap, era_fip_gap,
            wind_out_speed, wind_in_speed,
            park_adj_total, away_slg_delta,
            row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"build_run_features_for_date: done for {date}")
