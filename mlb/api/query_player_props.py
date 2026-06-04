import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL

def get_db():
    return psycopg2.connect(DATABASE_URL)

def query_player_props(date, prop_type=None, limit=15, min_edge=0.05, only_candidates=True, game_id=None):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    filters = ["DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s", "mp.market_type = 'player_prop'"]
    params = [date]
    if prop_type:
        filters.append('mp.prop_type = %s')
        params.append(prop_type)
    if only_candidates:
        filters.append("mp.card_decision = 'CANDIDATE'")
    if game_id:
        filters.append('mp.game_id = %s')
        params.append(game_id)
    filters.append('GREATEST(COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999)) >= %s')
    params.append(min_edge)
    where = ' AND '.join(filters)
    cur.execute(f'''
        SELECT
            mp.game_id, mp.player_id, mp.player_name, mp.prop_type,
            mp.model_mean, mp.k_pred_lo, mp.k_pred_hi, mp.line,
            mp.over_odds, mp.under_odds, mp.p_over, mp.p_under,
            mp.edge_over, mp.edge_under, mp.card_decision, mp.staking_pct,
            gc.game_date AT TIME ZONE 'America/New_York' AS game_time_et,
            ht.abbr AS home_team, at.abbr AS away_team,
            grd.park_runs_factor AS park_factor,
            COALESCE(bpf.opp_sp_era_xera_gap, psg.era_xera_gap) AS era_xera_gap,
            bpf.opp_sp_fip, bpf.opp_sp_xera,
            CASE WHEN COALESCE(bs.bp_ip_last_3d,0)>=15 THEN TRUE ELSE FALSE END AS bp_fatigue_flag
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        LEFT JOIN teams ht ON gc.home_team_id = ht.team_id
        LEFT JOIN teams at ON gc.away_team_id = at.team_id
        LEFT JOIN batter_prop_features bpf ON mp.game_id=bpf.game_id AND mp.player_id=bpf.player_id
        LEFT JOIN pitcher_k_games psg ON mp.game_id=psg.game_id AND mp.player_id=psg.pitcher_id
        LEFT JOIN game_run_data grd ON mp.game_id=grd.game_id
        LEFT JOIN bullpen_stats bs ON bs.team_id=gc.home_team_id AND bs.date=DATE(gc.game_date AT TIME ZONE 'America/New_York')
        WHERE {where}
        ORDER BY GREATEST(COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999)) DESC
        LIMIT {limit}
    ''', params)
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
