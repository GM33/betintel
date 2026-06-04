import psycopg2
import os
from datetime import datetime, timedelta

DATABASE_URL = os.environ.get("DATABASE_URL")


def get_active_alerts(market_type=None, severity=None, last_n_hours=24):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    filters = ["resolved_at IS NULL"]
    params = []

    if market_type:
        filters.append("market_type = %s")
        params.append(market_type)

    if severity:
        filters.append("severity = %s")
        params.append(severity)

    since = datetime.utcnow() - timedelta(hours=last_n_hours)
    filters.append("triggered_at >= %s")
    params.append(since)

    where_clause = " AND ".join(filters)

    query = f'''
        SELECT
            id,
            game_id,
            market_type,
            outcome_label,
            alert_type,
            severity,
            delta_pct,
            ev_delta,
            model_prob,
            market_prob,
            triggered_at,
            resolved_at,
            notes
        FROM mlb.line_alerts
        WHERE {where_clause}
        ORDER BY severity DESC, triggered_at DESC
    '''

    cur.execute(query, params)
    rows = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows


def get_alert_history(game_id=None, last_n_days=7):
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    filters = []
    params = []

    if game_id:
        filters.append("game_id = %s")
        params.append(game_id)

    since = datetime.utcnow() - timedelta(days=last_n_days)
    filters.append("triggered_at >= %s")
    params.append(since)

    where_clause = " AND ".join(filters) if filters else "TRUE"

    query = f'''
        SELECT
            id,
            game_id,
            market_type,
            outcome_label,
            alert_type,
            severity,
            delta_pct,
            ev_delta,
            triggered_at,
            resolved_at
        FROM mlb.line_alerts
        WHERE {where_clause}
        ORDER BY triggered_at DESC
        LIMIT 500
    '''

    cur.execute(query, params)
    rows = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows
