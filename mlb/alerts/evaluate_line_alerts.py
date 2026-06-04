import os
import psycopg2
from datetime import datetime, timedelta

DATABASE_URL = os.environ.get("DATABASE_URL")

# Thresholds
LINE_DELTA_THRESHOLD = float(os.environ.get("LINE_DELTA_THRESHOLD", "0.04"))  # 4% line move
EV_DELTA_THRESHOLD = float(os.environ.get("EV_DELTA_THRESHOLD", "0.02"))    # 2% EV shift
WINDOW_MINUTES = int(os.environ.get("SNAPSHOT_WINDOW_MINUTES", "5"))


def get_recent_deltas(conn, since):
    cur = conn.cursor()
    cur.execute("""
        SELECT
            game_id,
            market_type,
            outcome_label,
            open_line,
            current_line,
            delta_pct,
            open_prob,
            current_prob,
            (current_prob - open_prob) AS prob_delta
        FROM mlb.market_snapshots_deltas
        WHERE snapped_at >= %s
          AND delta_pct IS NOT NULL
    """, (since,))
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    cur.close()
    return [dict(zip(cols, r)) for r in rows]


def get_model_prob(conn, game_id, market_type, outcome_label):
    cur = conn.cursor()
    cur.execute("""
        SELECT predicted_prob
        FROM mlb.predictions
        WHERE game_id = %s
          AND market_type = %s
          AND outcome_label = %s
        ORDER BY created_at DESC
        LIMIT 1
    """, (game_id, market_type, outcome_label))
    row = cur.fetchone()
    cur.close()
    return row[0] if row else None


def alert_exists(conn, game_id, market_type, outcome_label, alert_type):
    cur = conn.cursor()
    cur.execute("""
        SELECT id FROM mlb.line_alerts
        WHERE game_id = %s
          AND market_type = %s
          AND outcome_label = %s
          AND alert_type = %s
          AND resolved_at IS NULL
          AND triggered_at >= NOW() - INTERVAL '1 hour'
    """, (game_id, market_type, outcome_label, alert_type))
    exists = cur.fetchone() is not None
    cur.close()
    return exists


def insert_alert(conn, game_id, market_type, outcome_label, alert_type,
                 severity, delta_pct, ev_delta, model_prob, market_prob, notes):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO mlb.line_alerts
            (game_id, market_type, outcome_label, alert_type, severity,
             delta_pct, ev_delta, model_prob, market_prob, notes, triggered_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
    """, (game_id, market_type, outcome_label, alert_type, severity,
           delta_pct, ev_delta, model_prob, market_prob, notes))
    cur.close()


def evaluate():
    conn = psycopg2.connect(DATABASE_URL)
    since = datetime.utcnow() - timedelta(minutes=WINDOW_MINUTES)
    deltas = get_recent_deltas(conn, since)
    alert_count = 0

    for d in deltas:
        game_id = d["game_id"]
        market_type = d["market_type"]
        outcome_label = d["outcome_label"]
        delta_pct = d["delta_pct"]
        current_prob = d["current_prob"]

        model_prob = get_model_prob(conn, game_id, market_type, outcome_label)
        ev_delta = None
        if model_prob is not None and current_prob is not None:
            ev_delta = round(model_prob - current_prob, 4)

        # Line movement alert
        if abs(delta_pct or 0) >= LINE_DELTA_THRESHOLD:
            alert_type = "LINE_MOVE"
            severity = "HIGH" if abs(delta_pct) >= 0.08 else "MEDIUM"
            if not alert_exists(conn, game_id, market_type, outcome_label, alert_type):
                notes = f"Line moved {round(delta_pct * 100, 1)}% in {WINDOW_MINUTES}min"
                insert_alert(conn, game_id, market_type, outcome_label, alert_type,
                             severity, delta_pct, ev_delta, model_prob, current_prob, notes)
                alert_count += 1

        # EV edge alert
        if ev_delta is not None and ev_delta >= EV_DELTA_THRESHOLD:
            alert_type = "EV_EDGE"
            severity = "HIGH" if ev_delta >= 0.05 else "MEDIUM"
            if not alert_exists(conn, game_id, market_type, outcome_label, alert_type):
                notes = f"Model edge {round(ev_delta * 100, 1)}% vs market"
                insert_alert(conn, game_id, market_type, outcome_label, alert_type,
                             severity, delta_pct, ev_delta, model_prob, current_prob, notes)
                alert_count += 1

    conn.commit()
    conn.close()
    print(f"[evaluate_line_alerts] {alert_count} alerts triggered at {datetime.utcnow().isoformat()}")


if __name__ == "__main__":
    evaluate()
