import psycopg2
from datetime import datetime
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.features.k")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def build_k_features_for_date(date: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT r.game_id,
               gc.home_team_id, gc.away_team_id,
               gc.home_sp_id, gc.away_sp_id,
               gc.venue_name, gc.weather_temp_f
        FROM results r
        JOIN game_context gc ON r.game_id = gc.game_id
        WHERE DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s
    """, (date,))
    games = cur.fetchall()

    for row in games:
        (game_id, home_team_id, away_team_id,
         home_sp_id, away_sp_id,
         venue_name, temp_f) = row

        # Pull K totals from results for each side
        cur.execute("""
            SELECT home_sp_ks, away_sp_ks, home_sp_ip, away_sp_ip
            FROM results WHERE game_id = %s
        """, (game_id,))
        res = cur.fetchone()
        if not res:
            continue
        home_sp_ks, away_sp_ks, home_sp_ip, away_sp_ip = res

        for sp_id, k_outs, sp_ip, team_id, opp_team_id, home_away in [
            (home_sp_id, home_sp_ks, home_sp_ip, home_team_id, away_team_id, 1),
            (away_sp_id, away_sp_ks, away_sp_ip, away_team_id, home_team_id, 0)
        ]:
            if not sp_id:
                continue

            cur.execute("""
                SELECT bp_ip_last_3d, bp_relievers_used_last_3d
                FROM bullpen_stats WHERE team_id=%s AND date=%s
            """, (opp_team_id, date))
            bp = cur.fetchone()

            # Pull all pitcher stats including ERA, xERA, xFIP, FIP for gap computation
            cur.execute("""
                SELECT p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
                       p_ip_per_start, p_hand,
                       p_era, p_xera, p_xfip, p_fip
                FROM pitcher_stats WHERE pitcher_id=%s
                ORDER BY last_updated DESC LIMIT 1
            """, (sp_id,))
            ps = cur.fetchone()
            if not ps:
                continue

            (p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
             p_ip_per_start, p_hand,
             p_era, p_xera, p_xfip, p_fip) = ps

            # Compute ERA-based regression gap signals
            era_xera_gap = None
            if p_era is not None and p_xera is not None:
                era_xera_gap = round(p_era - p_xera, 3)

            era_fip_gap = None
            if p_era is not None and p_fip is not None:
                era_fip_gap = round(p_era - p_fip, 3)

            cur.execute("""
                SELECT k_rate_vs_rh, k_rate_vs_lh, bb_rate_vs_rh, bb_rate_vs_lh
                FROM team_offense_stats WHERE team_id=%s
                ORDER BY last_updated DESC LIMIT 1
            """, (opp_team_id,))
            ts = cur.fetchone()
            if ts:
                opp_k_rate  = ts[0] if p_hand == 1 else ts[1]
                opp_bb_rate = ts[2] if p_hand == 1 else ts[3]
            else:
                opp_k_rate  = None
                opp_bb_rate = None

            cur.execute("""
                INSERT INTO pitcher_k_games (
                    game_id, date, pitcher_id, team_id, opp_team_id,
                    home_away, k_outs,
                    p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
                    p_ip_per_start, p_hand,
                    opp_k_rate_vs_hand, opp_bb_rate_vs_hand,
                    g_park_id,
                    bp_ip_last_3d, bp_relievers_used_last_3d,
                    era_xera_gap, era_fip_gap,
                    p_era, p_xera, p_xfip, p_fip,
                    created_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
            """, (
                game_id, date, sp_id, team_id, opp_team_id,
                home_away, k_outs,
                p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
                p_ip_per_start, p_hand,
                opp_k_rate, opp_bb_rate,
                venue_name,
                bp[0] if bp else None, bp[1] if bp else None,
                era_xera_gap, era_fip_gap,
                p_era, p_xera, p_xfip, p_fip,
                datetime.utcnow()
            ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"build_k_features_for_date: done for {date}")
