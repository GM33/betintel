import psycopg2
import os
from datetime import datetime, timedelta

DATABASE_URL = os.environ.get("DATABASE_URL")


def get_line_movement(market_type=None, last_n_days=1, min_delta_pct=0.02):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    filters = ["delta_pct IS NOT NULL", "ABS(delta_pct) >= %s"]
    params = [min_delta_pct]

    if market_type:
        filters.append("market_type = %s")
        params.append(market_type)

    since = datetime.utcnow() - timedelta(days=last_n_days)
    filters.append("snapped_at >= %s")
    params.append(since)

    where_clause = " AND ".join(filters)

    query = f'''
        SELECT
            game_id,
            market_type,
            outcome_label,
            open_line,
            current_line,
            delta_pct,
            open_prob,
            current_prob,
            prob_delta,
            snapped_at
        FROM mlb.market_snapshots_deltas
        WHERE {where_clause}
        ORDER BY ABS(delta_pct) DESC, snapped_at DESC
    '''

    cur.execute(query, params)
    rows = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows


def get_line_movement_by_game(game_id):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    query = '''
        SELECT
            market_type,
            outcome_label,
            open_line,
            current_line,
            delta_pct,
            open_prob,
            current_prob,
            prob_delta,
            snapped_at
        FROM mlb.market_snapshots_deltas
        WHERE game_id = %s
        ORDER BY market_type, snapped_at DESC
    '''

    cur.execute(query, (game_id,))
    rows = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
