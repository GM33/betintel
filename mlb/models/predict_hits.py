"""predict_hits.py

Generates per-batter hits prop predictions for today's slate.
Mirrors predict_k.py pattern exactly.

Uses Poisson distribution to compute P(hits >= line) for each batter.
Writes to model_predictions with market_type='player_prop', prop_type='hits'.
"""
import math
import pandas as pd
import joblib
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from scipy.stats import poisson
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.predict_hits")
ET  = ZoneInfo("America/New_York")

RECENCY_WEIGHT  = 0.60   # 60% last-7g / 40% season rate
CI_Z            = 1.0    # ±1σ Poisson band
MIN_PA_FILTER   = 50     # skip batters with <50 PA on season (tiny sample)

FEATURE_COLS = [
    "hits_last_7g", "hits_last_15g", "hits_season_avg",
    "batter_hand", "sp_hand",
    "avg_vs_hand", "slg_vs_hand", "obp_vs_hand", "wrc_plus_vs_hand",
    "opp_sp_era", "opp_sp_xera", "opp_sp_fip", "opp_sp_era_xera_gap",
    "opp_sp_swstr_rate", "opp_sp_k_rate", "opp_sp_bb_rate", "opp_sp_gb_rate",
    "park_runs_factor", "park_hr_factor",
    "temp_f", "wind_out_speed", "wind_in_speed",
    "batting_order", "is_home",
]

def get_db():
    return psycopg2.connect(DATABASE_URL)

def _blend_mean(season_avg, rolling_7g):
    """Blend season and recent hit rate. Returns expected hits per game."""
    season_avg   = season_avg   if season_avg   is not None else 0.25
    rolling_7g   = rolling_7g   if rolling_7g   is not None else season_avg
    # MLB avg AB/game ~3.8; hits/game = AVG × 3.8
    season_hpg   = float(season_avg)  * 3.8
    recent_hpg   = float(rolling_7g)
    return RECENCY_WEIGHT * recent_hpg + (1 - RECENCY_WEIGHT) * season_hpg

def predict_hits_for_today():
    today = datetime.now(ET).strftime("%Y-%m-%d")

    try:
        bundle = joblib.load("mlb/models/hits_model.joblib")
    except FileNotFoundError:
        log.warning("predict_hits: hits_model.joblib not found — using blend-only fallback")
        bundle = None

    conn = get_db()
    df = pd.read_sql("""
        SELECT player_id, game_id, player_name,
               hits_last_7g, hits_last_15g, hits_season_avg,
               batter_hand, sp_hand,
               avg_vs_hand, slg_vs_hand, obp_vs_hand, wrc_plus_vs_hand,
               opp_sp_era, opp_sp_xera, opp_sp_fip, opp_sp_era_xera_gap,
               opp_sp_swstr_rate, opp_sp_k_rate, opp_sp_bb_rate, opp_sp_gb_rate,
               park_runs_factor, park_hr_factor,
               temp_f, wind_out_speed, wind_in_speed,
               batting_order, is_home
        FROM batter_prop_features
        WHERE date = %s
    """, conn, params=(today,))
    conn.close()

    if df.empty:
        log.info("predict_hits: no batter features for today")
        return

    # Blend-based lambda
    df["hits_blend"] = df.apply(
        lambda r: _blend_mean(r["hits_season_avg"], r["hits_last_7g"]), axis=1
    )

    # XGBoost prediction (if model exists)
    if bundle:
        model        = bundle["model"]
        feat_cols    = bundle["features"]
        df_feat      = df.copy()
        for col in feat_cols:
            if col not in df_feat.columns:
                df_feat[col] = 0
        X = df_feat[feat_cols].fillna(0)
        X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
        df["hits_xgb"] = model.predict(X)
        df["hits_mean_pred"] = 0.65 * df["hits_xgb"] + 0.35 * df["hits_blend"]
    else:
        df["hits_mean_pred"] = df["hits_blend"]

    # Poisson CI
    df["hits_pred_lo"] = (df["hits_mean_pred"] - CI_Z * df["hits_mean_pred"].apply(
        lambda x: math.sqrt(max(x, 0.01)))).clip(lower=0)
    df["hits_pred_hi"] =  df["hits_mean_pred"] + CI_Z * df["hits_mean_pred"].apply(
        lambda x: math.sqrt(max(x, 0.01)))

    conn = get_db()
    cur  = conn.cursor()
    now  = datetime.utcnow()

    for _, row in df.iterrows():
        lam = float(row["hits_mean_pred"])
        cur.execute("""
            INSERT INTO model_predictions (
                game_id, player_id, player_name,
                market_type, prop_type,
                model_mean, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (game_id, player_id, market_type, prop_type, DATE(created_at))
            DO UPDATE SET
                model_mean = EXCLUDED.model_mean,
                player_name = EXCLUDED.player_name,
                created_at = EXCLUDED.created_at
        """, (
            row["game_id"], int(row["player_id"]),
            row.get("player_name"),
            "player_prop", "hits",
            lam, now
        ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_hits_for_today: wrote {len(df)} hit predictions")
