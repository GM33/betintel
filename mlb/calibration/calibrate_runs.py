import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import poisson
from mlb.config import DATABASE_URL
from datetime import datetime
import logging

log = logging.getLogger("betintel.calibration.runs")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def implied_prob_american(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)

def run_calibration_update_runs(last_n_days: int = 30, gamma: float = 1.86):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT r.game_id, r.home_runs, r.away_runs,
               mp.model_mean_home, mp.model_mean_away,
               ml.home_odds AS ml_home_odds, ml.away_odds AS ml_away_odds,
               tot.line AS total_line,
               tot.over_odds AS total_over_odds, tot.under_odds AS total_under_odds,
               r.game_total
        FROM results r
        JOIN model_predictions mp
          ON r.game_id = mp.game_id
         AND mp.market_type = 'game' AND mp.prop_type = 'runs'
        LEFT JOIN LATERAL (
            SELECT home_odds, away_odds FROM market_snapshots
            WHERE game_id = r.game_id AND market_type = 'h2h'
            ORDER BY snapshot_time DESC LIMIT 1
        ) ml ON TRUE
        LEFT JOIN LATERAL (
            SELECT line, over_odds, under_odds FROM market_snapshots
            WHERE game_id = r.game_id AND market_type = 'totals'
            ORDER BY snapshot_time DESC LIMIT 1
        ) tot ON TRUE
        WHERE r.result_fetched_at >= NOW() - INTERVAL '%s days'
    """, (last_n_days,))
    rows = cur.fetchall()
    cur.close()
    conn.close()

    if not rows:
        log.info("run_calibration_update_runs: no rows")
        return

    brier_ml, roi_ml, brier_tot, roi_tot = [], [], [], []
    max_r = 15

    for row in rows:
        mu_h, mu_a = row["model_mean_home"], row["model_mean_away"]
        home_runs, away_runs = row["home_runs"], row["away_runs"]
        if not mu_h or not mu_a or home_runs is None:
            continue
        p_home = float(mu_h**gamma / (mu_h**gamma + mu_a**gamma))
        outcome_home = 1 if home_runs > away_runs else 0
        brier_ml.append((p_home - outcome_home) ** 2)
        p_imp_home = implied_prob_american(row["ml_home_odds"])
        if p_imp_home and (p_home - p_imp_home) > 0.03:
            ml_odds = row["ml_home_odds"]
            profit = (ml_odds / 100 if ml_odds > 0 else 100 / -ml_odds) if outcome_home == 1 else -1
            roi_ml.append(profit)

        line = row["total_line"]
        total = row["game_total"]
        if line and total is not None:
            probs_h = [float(poisson.pmf(k, mu_h)) for k in range(max_r + 1)]
            probs_a = [float(poisson.pmf(k, mu_a)) for k in range(max_r + 1)]
            probs_tot = [0.0] * (2 * max_r + 2)
            for i in range(max_r + 1):
                for j in range(max_r + 1):
                    probs_tot[i + j] += probs_h[i] * probs_a[j]
            p_over = float(sum(probs_tot[int(line) + 1:]))
            outcome_over = 1 if total > line else 0
            brier_tot.append((p_over - outcome_over) ** 2)
            p_imp_over = implied_prob_american(row["total_over_odds"])
            if p_imp_over and (p_over - p_imp_over) > 0.03:
                oo = row["total_over_odds"]
                profit = (oo / 100 if oo > 0 else 100 / -oo) if outcome_over == 1 else -1
                roi_tot.append(profit)

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()
    if brier_ml:
        drift = float(np.mean(brier_ml)) > 0.25 or (float(np.mean(roi_ml)) < 0 if roi_ml else False)
        cur.execute("""
            INSERT INTO model_calibration
            (market_type, last_n_days, brier_score, roi, sample_size, drift_alert, computed_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
        """, ("ml", last_n_days, float(np.mean(brier_ml)), float(np.mean(roi_ml)) if roi_ml else 0.0, len(brier_ml), drift, now))
        if drift:
            log.warning("DRIFT ALERT: ML model")
    if brier_tot:
        drift = float(np.mean(brier_tot)) > 0.25 or (float(np.mean(roi_tot)) < 0 if roi_tot else False)
        cur.execute("""
            INSERT INTO model_calibration
            (market_type, last_n_days, brier_score, roi, sample_size, drift_alert, computed_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
        """, ("totals", last_n_days, float(np.mean(brier_tot)), float(np.mean(roi_tot)) if roi_tot else 0.0, len(brier_tot), drift, now))
        if drift:
            log.warning("DRIFT ALERT: Totals model")
    conn.commit()
    cur.close()
    conn.close()
    log.info("run_calibration_update_runs: complete")
