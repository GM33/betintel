"""run_calibration.py — BetIntel nightly model calibration loop.

Runs after results are ingested (startup step 16).
For each market type (player_prop, game_moneyline, game_total),
computes over the last 7, 14, and 30 days:
  - Brier Score       : mean squared error of model probability vs binary outcome
  - MAE               : mean absolute error of model_mean vs actual result
  - ROI               : net units won / total units staked on CANDIDATE picks
  - Sample size       : number of resolved predictions in window
  - Drift alert       : TRUE if Brier score degraded >5% vs prior 7-day window

Writes one row per (market_type, last_n_days) into model_calibration.
Fully idempotent — upserts on (market_type, last_n_days, DATE(computed_at)).
"""
import psycopg2
import psycopg2.extras
import logging
from datetime import datetime, timezone
from mlb.config import DATABASE_URL

log = logging.getLogger("betintel.calibration")

WINDOWS = [7, 14, 30]

# Brier degradation threshold that fires drift_alert
DRIFT_THRESHOLD = 0.05   # 5%

def get_db():
    return psycopg2.connect(DATABASE_URL)

# ── Helpers ────────────────────────────────────────────────────────────────────

def _safe_div(a, b):
    return round(a / b, 6) if b else None

def _american_to_decimal(odds: int) -> float | None:
    """Convert American odds to decimal (profit per $1 staked)."""
    if odds is None:
        return None
    return (odds / 100) if odds > 0 else (100 / -odds)

# ── Per-market calibration ─────────────────────────────────────────────────────

def _calibrate_market(cur, market_type: str, window_days: int) -> dict | None:
    """
    Joins model_predictions → results for resolved picks in the window.
    Returns a dict of calibration metrics or None if no data.
    """

    if market_type == "player_prop":
        # K strikeout props: outcome = 1 if actual_ks >= line (over hit)
        cur.execute("""
            SELECT
                mp.p_over,
                mp.p_under,
                mp.model_mean,
                mp.line,
                mp.card_decision,
                mp.staking_pct,
                mp.edge_over,
                mp.edge_under,
                mp.over_odds,
                mp.under_odds,
                CASE WHEN mp.p_over >= 0.5 THEN 'over' ELSE 'under' END AS model_lean,
                -- Actual outcome: did the over hit?
                CASE WHEN (
                    (gc.home_sp_id = mp.player_id AND r.home_sp_ks >= mp.line)
                    OR
                    (gc.away_sp_id = mp.player_id AND r.away_sp_ks >= mp.line)
                ) THEN 1 ELSE 0 END AS outcome_over,
                -- Actual Ks
                CASE
                    WHEN gc.home_sp_id = mp.player_id THEN r.home_sp_ks
                    WHEN gc.away_sp_id = mp.player_id THEN r.away_sp_ks
                END AS actual_value
            FROM model_predictions mp
            JOIN game_context gc ON mp.game_id = gc.game_id
            JOIN results r       ON mp.game_id = r.game_id
            WHERE mp.market_type = 'player_prop'
              AND mp.p_over IS NOT NULL
              AND mp.line   IS NOT NULL
              AND mp.created_at >= NOW() - INTERVAL '%s days'
        """, (window_days,))

    elif market_type == "game_moneyline":
        cur.execute("""
            SELECT
                mp.p_home,
                mp.p_away,
                mp.model_mean_home,
                mp.model_mean_away,
                mp.card_decision,
                mp.staking_pct,
                mp.edge_home,
                mp.edge_away,
                mp.home_odds,
                mp.away_odds,
                CASE WHEN mp.p_home >= 0.5 THEN 'home' ELSE 'away' END AS model_lean,
                CASE WHEN r.home_runs > r.away_runs THEN 1 ELSE 0 END  AS outcome_home,
                r.home_runs,
                r.away_runs
            FROM model_predictions mp
            JOIN results r ON mp.game_id = r.game_id
            WHERE mp.market_type = 'game'
              AND mp.p_home IS NOT NULL
              AND mp.created_at >= NOW() - INTERVAL '%s days'
        """, (window_days,))

    elif market_type == "game_total":
        cur.execute("""
            SELECT
                mp.p_over,
                mp.p_under,
                mp.model_mean_home + mp.model_mean_away AS model_total,
                mp.line,
                mp.card_decision,
                mp.staking_pct,
                mp.edge_over,
                mp.edge_under,
                mp.over_odds,
                mp.under_odds,
                CASE WHEN mp.p_over >= 0.5 THEN 'over' ELSE 'under' END AS model_lean,
                CASE WHEN r.game_total > mp.line THEN 1 ELSE 0 END       AS outcome_over,
                r.game_total AS actual_value
            FROM model_predictions mp
            JOIN results r ON mp.game_id = r.game_id
            WHERE mp.market_type = 'game'
              AND mp.p_over  IS NOT NULL
              AND mp.line    IS NOT NULL
              AND mp.created_at >= NOW() - INTERVAL '%s days'
        """, (window_days,))
    else:
        return None

    rows = cur.fetchall()
    if not rows:
        log.info(f"calibrate: {market_type} / {window_days}d — no data")
        return None

    brier_sum   = 0.0
    mae_sum     = 0.0
    mae_n       = 0
    net_units   = 0.0
    total_stake = 0.0
    n           = len(rows)

    for row in rows:
        row = dict(row)

        # ── Brier score component ────────────────────────────────────────────
        if market_type in ("player_prop", "game_total"):
            p_pred   = row.get("p_over") or 0.0
            outcome  = row.get("outcome_over", 0)
        else:  # moneyline
            p_pred   = row.get("p_home") or 0.0
            outcome  = row.get("outcome_home", 0)
        brier_sum += (p_pred - outcome) ** 2

        # ── MAE component ────────────────────────────────────────────────────
        actual = row.get("actual_value") or row.get("home_runs")
        model  = (
            row.get("model_mean")
            or row.get("model_total")
            or row.get("model_mean_home")
        )
        if actual is not None and model is not None:
            mae_sum += abs(float(actual) - float(model))
            mae_n   += 1

        # ── ROI on CANDIDATE picks only ──────────────────────────────────────
        if row.get("card_decision") == "CANDIDATE":
            stake = float(row.get("staking_pct") or 0.01)  # default 1% if missing
            total_stake += stake

            if market_type in ("player_prop", "game_total"):
                lean    = row.get("model_lean")
                outcome = row.get("outcome_over", 0)
                if lean == "over":
                    odds    = row.get("over_odds")
                    dec     = _american_to_decimal(odds)
                    won     = outcome == 1
                else:
                    odds    = row.get("under_odds")
                    dec     = _american_to_decimal(odds)
                    won     = outcome == 0
            else:
                lean    = row.get("model_lean")
                outcome = row.get("outcome_home", 0)
                if lean == "home":
                    odds    = row.get("home_odds")
                    dec     = _american_to_decimal(odds)
                    won     = outcome == 1
                else:
                    odds    = row.get("away_odds")
                    dec     = _american_to_decimal(odds)
                    won     = outcome == 0

            if dec is not None:
                net_units += (stake * dec) if won else (-stake)

    brier  = round(brier_sum / n, 6)
    mae    = round(mae_sum / mae_n, 4) if mae_n else None
    roi    = round(net_units / total_stake, 4) if total_stake else None

    return {
        "brier_score": brier,
        "mae":         mae,
        "roi":         roi,
        "sample_size": n,
    }

# ── Drift detection ────────────────────────────────────────────────────────────

def _get_prior_brier(cur, market_type: str, window_days: int) -> float | None:
    """Fetch the most recent Brier score for this market/window (excluding today)."""
    cur.execute("""
        SELECT brier_score FROM model_calibration
        WHERE market_type  = %s
          AND last_n_days  = %s
          AND DATE(computed_at) < CURRENT_DATE
        ORDER BY computed_at DESC
        LIMIT 1
    """, (market_type, window_days))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] else None

# ── Main entry point ───────────────────────────────────────────────────────────

def run_calibration():
    """Compute and upsert calibration metrics for all markets and windows."""
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    now  = datetime.now(timezone.utc)

    markets = ["player_prop", "game_moneyline", "game_total"]
    written = 0

    for market_type in markets:
        for window_days in WINDOWS:
            metrics = _calibrate_market(cur, market_type, window_days)
            if metrics is None:
                continue

            # Drift detection — compare to prior 7d window Brier
            drift_alert = False
            if window_days == 7:
                prior_brier = _get_prior_brier(cur, market_type, 7)
                if prior_brier is not None and metrics["brier_score"] > 0:
                    pct_change = (metrics["brier_score"] - prior_brier) / prior_brier
                    drift_alert = pct_change > DRIFT_THRESHOLD
                    if drift_alert:
                        log.warning(
                            f"DRIFT ALERT: {market_type} 7d Brier "
                            f"{prior_brier:.4f} → {metrics['brier_score']:.4f} "
                            f"(+{pct_change*100:.1f}%)"
                        )

            # Upsert on (market_type, last_n_days, date)
            write_cur = conn.cursor()
            write_cur.execute("""
                INSERT INTO model_calibration
                    (market_type, last_n_days, brier_score, mae, roi,
                     sample_size, drift_alert, computed_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (market_type, last_n_days, calibration_date)
                DO UPDATE SET
                    brier_score  = EXCLUDED.brier_score,
                    mae          = EXCLUDED.mae,
                    roi          = EXCLUDED.roi,
                    sample_size  = EXCLUDED.sample_size,
                    drift_alert  = EXCLUDED.drift_alert,
                    computed_at  = EXCLUDED.computed_at
            """, (
                market_type,
                window_days,
                metrics["brier_score"],
                metrics["mae"],
                metrics["roi"],
                metrics["sample_size"],
                drift_alert,
                now,
            ))
            write_cur.close()
            written += 1
            log.info(
                f"calibration: {market_type} / {window_days}d | "
                f"Brier={metrics['brier_score']:.4f} "
                f"MAE={metrics['mae']} ROI={metrics['roi']} "
                f"n={metrics['sample_size']} drift={'⚠️' if drift_alert else 'OK'}"
            )

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"run_calibration: wrote {written} rows to model_calibration")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_calibration()
