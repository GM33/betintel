import math
import pandas as pd
import joblib
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from scipy.stats import poisson
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.predict_k")
ET = ZoneInfo("America/New_York")

# ── Accuracy constants ──────────────────────────────────────────────────────
# Max innings a SP is realistically expected to throw in 2026
MAX_IP_CAP = 6.0
# Recency weight: last-5-start rolling avg blended with season rate
RECENCY_WEIGHT = 0.55   # 55% recent / 45% season
# Confidence interval coverage for card display
CI_Z = 1.0              # ±1 sigma  (~68% interval)
# Minimum SwStr% to trust the model (filter relievers / openers)
MIN_SWSTR = 0.07


def get_db():
    return psycopg2.connect(DATABASE_URL)


def _half_line_p_over(lam: float, line: float) -> float:
    """
    Correct Poisson P(K > line) for both whole and half lines.
    For a half line (e.g. 6.5): P(K >= 7) = 1 - CDF(6)
    For a whole line (e.g. 6):  P(K >= 7) = 1 - CDF(6)   [push impossible — same]
    Explicitly uses math.floor so int-cast truncation never silently swallows a half.
    """
    floored = math.floor(line)
    return float(1 - poisson.cdf(floored, lam))


def _blend_mean(season_k_rate: float, recent_k_rate: float | None,
                ip_per_start: float) -> float:
    """
    Blend season K-rate with last-5 rolling rate, then cap by expected IP.
    Returns predicted K count (lambda) for the start.
    """
    if recent_k_rate is not None:
        blended_rate = RECENCY_WEIGHT * recent_k_rate + (1 - RECENCY_WEIGHT) * season_k_rate
    else:
        blended_rate = season_k_rate

    # Cap IP at MAX_IP_CAP — prevents over-projection for deep starters
    effective_ip = min(ip_per_start, MAX_IP_CAP)
    return blended_rate * effective_ip


def predict_k_for_today():
    conn = get_db()
    today = datetime.now(ET).strftime("%Y-%m-%d")

    try:
        bundle = joblib.load("mlb/models/k_model.joblib")
    except FileNotFoundError:
        log.error("predict_k_for_today: k_model.joblib not found — run train_k_model first")
        return

    model = bundle["model"]
    feature_cols = bundle["features"]

    df = pd.read_sql("""
        SELECT
            game_id, pitcher_id,
            p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
            p_ip_per_start, p_hand,
            opp_k_rate_vs_hand, opp_bb_rate_vs_hand,
            home_away, g_park_id,
            bp_ip_last_3d, bp_relievers_used_last_3d,
            ump_k_rate_diff,
            p_k_rate_last5, p_ip_last5_avg
        FROM pitcher_k_games
        WHERE DATE(date) = %s
    """, conn, params=(today,))
    conn.close()

    if df.empty:
        log.info("predict_k_for_today: no rows for today")
        return

    # ── Accuracy fix 1: drop openers / bulk relievers ────────────────────
    if "p_swstr_rate" in df.columns:
        before = len(df)
        df = df[df["p_swstr_rate"].fillna(0) >= MIN_SWSTR]
        log.info(f"predict_k_for_today: filtered {before - len(df)} opener/bullpen rows")

    # ── Accuracy fix 2: recency-blended lambda ───────────────────────────
    if "p_k_rate_last5" in df.columns and "p_ip_last5_avg" in df.columns:
        df["k_mean_blended"] = df.apply(
            lambda r: _blend_mean(
                r["p_k_rate"] if pd.notna(r["p_k_rate"]) else 0,
                r["p_k_rate_last5"] if pd.notna(r["p_k_rate_last5"]) else None,
                r["p_ip_per_start"] if pd.notna(r["p_ip_per_start"]) else 5.5,
            ), axis=1
        )
    else:
        df["k_mean_blended"] = (
            df["p_k_rate"].fillna(0) *
            df["p_ip_per_start"].fillna(5.5).clip(upper=MAX_IP_CAP)
        )

    # ── Accuracy fix 3: XGBoost prediction (primary) ─────────────────────
    df["p_hand"] = df["p_hand"].fillna(1)
    df = pd.get_dummies(df, columns=["g_park_id"], drop_first=True)
    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0
    X = df[feature_cols].fillna(0)
    df["k_xgb_pred"] = model.predict(X)

    # ── Accuracy fix 4: ensemble — blend XGB with recency lambda ─────────
    df["k_mean_pred"] = 0.65 * df["k_xgb_pred"] + 0.35 * df["k_mean_blended"]

    # ── Accuracy fix 5: Poisson confidence interval ───────────────────────
    # sigma of Poisson = sqrt(lambda); store ±1σ band for card display
    df["k_pred_lo"] = (df["k_mean_pred"] - CI_Z * df["k_mean_pred"].apply(math.sqrt)).clip(lower=0)
    df["k_pred_hi"] =  df["k_mean_pred"] + CI_Z * df["k_mean_pred"].apply(math.sqrt)

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()

    for _, row in df.iterrows():
        lam = float(row["k_mean_pred"])

        # ── Accuracy fix 6: duplicate guard — upsert instead of blind INSERT ──
        cur.execute("""
            INSERT INTO model_predictions (
                game_id, player_id, market_type, prop_type,
                model_mean, k_pred_lo, k_pred_hi, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (game_id, player_id, market_type, prop_type, DATE(created_at))
            DO UPDATE SET
                model_mean  = EXCLUDED.model_mean,
                k_pred_lo   = EXCLUDED.k_pred_lo,
                k_pred_hi   = EXCLUDED.k_pred_hi,
                created_at  = EXCLUDED.created_at
        """, (
            row["game_id"], int(row["pitcher_id"]),
            "player_prop", "k_strikeouts",
            lam,
            float(row["k_pred_lo"]),
            float(row["k_pred_hi"]),
            now,
        ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_k_for_today: wrote {len(df)} predictions (ensemble XGB+recency blend)")
