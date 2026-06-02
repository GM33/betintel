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
               gc.venue_name, gc.weather_temp_f,
               r.home_sp_ks, r.away_sp_ks,
               r.home_sp_ip, r.away_sp_ip
        FROM results r
        JOIN game_context gc ON r.game_id = gc.game_id
        WHERE DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s
    """, (date,))
    games = cur.fetchall()

    for row in games:
        (game_id, home_team_id, away_team_id,
         home_sp_id, away_sp_id,
         venue_name, temp_f,
         home_sp_ks, away_sp_ks,
         home_sp_ip, away_sp_ip) = row

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

            cur.execute("""
                SELECT p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
                       p_ip_per_start, p_hand
                FROM pitcher_stats WHERE pitcher_id=%s
                ORDER BY last_updated DESC LIMIT 1
            """, (sp_id,))
            ps = cur.fetchone()
            if not ps:
                continue

            cur.execute("""
                SELECT k_rate_vs_rh, k_rate_vs_lh
                FROM team_offense_stats WHERE team_id=%s
                ORDER BY last_updated DESC LIMIT 1
            """, (opp_team_id,))
            ts = cur.fetchone()
            opp_k_rate = ts[0] if ts and ps[5] == 1 else (ts[1] if ts else None)

            cur.execute("""
                INSERT INTO pitcher_k_games (
                    game_id, date, pitcher_id, team_id, opp_team_id,
                    home_away, k_outs,
                    p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
                    p_ip_per_start, p_hand,
                    opp_k_rate_vs_hand, g_park_id,
                    bp_ip_last_3d, bp_relievers_used_last_3d, created_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
            """, (
                game_id, date, sp_id, team_id, opp_team_id,
                home_away, k_outs,
                ps[0], ps[1], ps[2], ps[3], ps[4], ps[5],
                opp_k_rate, venue_name,
                bp[0] if bp else None, bp[1] if bp else None,
                datetime.utcnow()
            ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"build_k_features_for_date: done for {date}")
