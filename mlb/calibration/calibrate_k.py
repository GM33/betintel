import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import poisson
from mlb.config import DATABASE_URL
from datetime import datetime
import logging

log = logging.getLogger("betintel.calibration.k")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def implied_prob_american(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)

def run_calibration_update_k(last_n_days: int = 30):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT mp.game_id, mp.player_id, mp.model_mean,
               ms.line, ms.over_odds, ms.under_odds,
               r.home_sp_id, r.away_sp_id, r.home_sp_ks, r.away_sp_ks
        FROM model_predictions mp
        JOIN market_snapshots ms
          ON mp.game_id = ms.game_id
         AND mp.player_id = ms.player_id
         AND ms.market_type = 'player_prop'
         AND ms.prop_type = 'k_strikeouts'
        JOIN results r ON mp.game_id = r.game_id
        WHERE mp.created_at >= NOW() - INTERVAL '%s days'
    """, (last_n_days,))
    rows = cur.fetchall()
    cur.close()
    conn.close()

    if not rows:
        log.info("run_calibration_update_k: no rows")
        return

    brier_scores, maes, roi_list = [], [], []
    for row in rows:
        lam = row["model_mean"]
        line = row["line"]
        actual_k = row["home_sp_ks"] if row["player_id"] == row["home_sp_id"] else row["away_sp_ks"]
        if actual_k is None or not lam or not line:
            continue
        p_over = float(1 - poisson.cdf(int(line), lam))
        outcome_over = 1 if actual_k > line else 0
        brier_scores.append((p_over - outcome_over) ** 2)
        maes.append(abs(lam - actual_k))
        p_imp_over = implied_prob_american(row["over_odds"])
        if p_imp_over and (p_over - p_imp_over) > 0.03:
            over_odds = row["over_odds"]
            profit = (over_odds / 100 if over_odds > 0 else 100 / -over_odds) if outcome_over == 1 else -1
            roi_list.append(profit)

    if brier_scores:
        avg_brier = float(np.mean(brier_scores))
        avg_mae = float(np.mean(maes))
        avg_roi = float(np.mean(roi_list)) if roi_list else 0.0
        drift = avg_brier > 0.25 or avg_roi < 0
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO model_calibration
            (market_type, last_n_days, brier_score, mae, roi, sample_size, drift_alert, computed_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        """, ("k_strikeouts", last_n_days, avg_brier, avg_mae, avg_roi, len(brier_scores), drift, datetime.utcnow()))
        conn.commit()
        cur.close()
        conn.close()
        log.info(f"K calibration {last_n_days}d: Brier={avg_brier:.4f} MAE={avg_mae:.3f} ROI={avg_roi:.3f} DRIFT={drift}")
        if drift:
            log.warning("DRIFT ALERT: K model — review before next publish")
