import psycopg2
from datetime import datetime
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.features.game")


def get_db():
    return psycopg2.connect(DATABASE_URL)


def build_game_features_for_date(date: str):
    """
    Safe backfill/update pass for June 3 model upgrades.

    This function expects nullable columns to exist in game_run_data:
    - team_slg_recent
    - opp_slg_recent
    - sp_era
    - sp_proj_era
    - sp_era_gap
    - bp_fatigue_idx
    - park_total_adjustment
    - underdog_confidence_flag

    It fills what it can from existing tables and leaves the rest null/0-safe.
    """
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            grd.game_id,
            grd.team_id,
            grd.is_home,
            gc.home_team_id,
            gc.away_team_id,
            gc.home_sp_id,
            gc.away_sp_id,
            COALESCE(grd.park_runs_factor, 1.0) AS park_runs_factor
        FROM game_run_data grd
        JOIN game_context gc ON grd.game_id = gc.game_id
        WHERE DATE(grd.date) = %s
    """, (date,))
    rows = cur.fetchall()

    for row in rows:
        game_id, team_id, is_home, home_team_id, away_team_id, home_sp_id, away_sp_id, park_runs_factor = row
        opp_team_id = away_team_id if team_id == home_team_id else home_team_id
        opp_sp_id = away_sp_id if team_id == home_team_id else home_sp_id

        team_slg_recent = None
        opp_slg_recent = None
        sp_era = None
        sp_proj_era = None
        bp_fatigue_idx = None
        underdog_confidence_flag = 0

        cur.execute("""
            SELECT slugging_pct
            FROM team_offense_stats
            WHERE team_id = %s
            ORDER BY last_updated DESC
            LIMIT 1
        """, (team_id,))
        rec = cur.fetchone()
        if rec:
            team_slg_recent = rec[0]

        cur.execute("""
            SELECT slugging_pct
            FROM team_offense_stats
            WHERE team_id = %s
            ORDER BY last_updated DESC
            LIMIT 1
        """, (opp_team_id,))
        rec = cur.fetchone()
        if rec:
            opp_slg_recent = rec[0]

        cur.execute("""
            SELECT era, COALESCE(xfip, fip)
            FROM pitcher_stats
            WHERE pitcher_id = %s
            ORDER BY last_updated DESC
            LIMIT 1
        """, (opp_sp_id,))
        rec = cur.fetchone()
        if rec:
            sp_era, sp_proj_era = rec

        cur.execute("""
            SELECT bp_ip_last_3d
            FROM bullpen_stats
            WHERE team_id = %s AND date = %s
            LIMIT 1
        """, (opp_team_id, date))
        rec = cur.fetchone()
        if rec:
            bp_fatigue_idx = rec[0]

        sp_era_gap = None
        if sp_era is not None and sp_proj_era is not None:
            sp_era_gap = float(sp_proj_era) - float(sp_era)

        team_slg_delta = None
        if team_slg_recent is not None and opp_slg_recent is not None:
            team_slg_delta = float(team_slg_recent) - float(opp_slg_recent)

        if team_slg_delta is not None and team_slg_delta >= 0.015 and is_home == 0:
            underdog_confidence_flag = 1
        if sp_era_gap is not None and sp_era_gap >= 1.5 and is_home == 0:
            underdog_confidence_flag = 1

        park_total_adjustment = float(park_runs_factor) - 1.0 if park_runs_factor is not None else 0.0

        cur.execute("""
            UPDATE game_run_data
            SET team_slg_recent = COALESCE(%s, team_slg_recent),
                opp_slg_recent = COALESCE(%s, opp_slg_recent),
                sp_era = COALESCE(%s, sp_era),
                sp_proj_era = COALESCE(%s, sp_proj_era),
                sp_era_gap = COALESCE(%s, sp_era_gap),
                bp_fatigue_idx = COALESCE(%s, bp_fatigue_idx),
                park_total_adjustment = COALESCE(%s, park_total_adjustment),
                underdog_confidence_flag = COALESCE(%s, underdog_confidence_flag)
            WHERE game_id = %s AND team_id = %s AND is_home = %s
        """, (
            team_slg_recent,
            opp_slg_recent,
            sp_era,
            sp_proj_era,
            sp_era_gap,
            bp_fatigue_idx,
            park_total_adjustment,
            underdog_confidence_flag,
            game_id,
            team_id,
            is_home,
        ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"build_game_features_for_date: done for {date}")
