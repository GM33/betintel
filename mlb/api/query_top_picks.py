import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL

def get_db():
    return psycopg2.connect(DATABASE_URL)

def query_top_picks(date, limit=10, market_filter='all', min_edge=0.05):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    market_sql = ''
    params = [date, min_edge]
    if market_filter == 'ml':
        market_sql = 'AND mp.line IS NULL'
    elif market_filter == 'total':
        market_sql = 'AND mp.line IS NOT NULL AND mp.p_over IS NOT NULL'
    cur.execute(f'''
        WITH latest_snap AS (
            SELECT DISTINCT ON (game_id, market_type)
                game_id, market_type, line,
                home_odds, away_odds, over_odds, under_odds, captured_at
            FROM market_snapshots
            ORDER BY game_id, market_type, captured_at DESC
        )
        SELECT
            mp.game_id,
            gc.game_date AT TIME ZONE 'America/New_York' AS game_time_et,
            ht.abbr AS home_team,
            at.abbr AS away_team,
            grd.park_runs_factor AS park_factor,
            CASE WHEN COALESCE(mp.edge_home,-999)>=COALESCE(mp.edge_away,-999) THEN 'moneyline' ELSE 'moneyline' END AS market_type,
            CASE WHEN COALESCE(mp.edge_home,-999)>=COALESCE(mp.edge_away,-999) THEN 'home' ELSE 'away' END AS lean,
            CASE WHEN COALESCE(mp.edge_home,-999)>=COALESCE(mp.edge_away,-999) THEN ht.abbr ELSE at.abbr END AS lean_team,
            CASE WHEN COALESCE(mp.edge_home,-999)>=COALESCE(mp.edge_away,-999) THEN mp.p_home ELSE mp.p_away END AS model_prob,
            CASE WHEN COALESCE(mp.edge_home,-999)>=COALESCE(mp.edge_away,-999) THEN ls.home_odds ELSE ls.away_odds END AS book_odds,
            GREATEST(COALESCE(mp.edge_home,-999),COALESCE(mp.edge_away,-999),COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999)) AS edge,
            mp.staking_pct AS kelly_stake,
            CASE WHEN COALESCE(grd.bp_home_ip_last_3d,0)>=15 OR COALESCE(grd.bp_away_ip_last_3d,0)>=15 THEN TRUE ELSE FALSE END AS bp_fatigue_flag,
            COALESCE(ps_home.era_xera_gap, ps_away.era_xera_gap) AS era_xera_gap,
            jsonb_build_object('home_edge',mp.edge_home,'away_edge',mp.edge_away,'over_edge',mp.edge_over,'under_edge',mp.edge_under) AS signals,
            NULL AS implied_prob
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        LEFT JOIN latest_snap ls ON mp.game_id = ls.game_id AND ls.market_type='game_moneyline'
        LEFT JOIN teams ht ON gc.home_team_id = ht.team_id
        LEFT JOIN teams at ON gc.away_team_id = at.team_id
        LEFT JOIN game_run_data grd ON mp.game_id = grd.game_id
        LEFT JOIN pitcher_stats ps_home ON gc.home_sp_id = ps_home.pitcher_id
        LEFT JOIN pitcher_stats ps_away ON gc.away_sp_id = ps_away.pitcher_id
        WHERE mp.market_type = 'game'
          AND DATE(gc.game_date AT TIME ZONE 'America/New_York') = %s
          AND mp.card_decision = 'CANDIDATE'
          AND GREATEST(COALESCE(mp.edge_home,-999),COALESCE(mp.edge_away,-999),COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999)) >= %s
          {market_sql}
        ORDER BY GREATEST(COALESCE(mp.edge_home,-999),COALESCE(mp.edge_away,-999),COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999)) DESC
        LIMIT {limit}
    ''', params)
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
