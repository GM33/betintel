import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL

def get_db():
    return psycopg2.connect(DATABASE_URL)

def query_calibration(market_filter='all'):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    filters = []
    params = []
    if market_filter != 'all':
        filters.append('market_type = %s')
        params.append(market_filter)
    where_sql = f"WHERE {' AND '.join(filters)}" if filters else ''
    cur.execute(f'''
        WITH ranked AS (
            SELECT market_type, last_n_days, brier_score, mae, roi,
                   sample_size, drift_alert, computed_at,
                   ROW_NUMBER() OVER (PARTITION BY market_type, last_n_days ORDER BY computed_at DESC) AS rn
            FROM model_calibration
            {where_sql}
        )
        SELECT market_type, last_n_days, brier_score, mae, roi,
               sample_size, drift_alert, computed_at
        FROM ranked WHERE rn = 1
        ORDER BY market_type, last_n_days
    ''', params)
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
