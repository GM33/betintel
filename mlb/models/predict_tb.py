"""predict_tb.py

Generates per-batter total bases prop predictions for today's slate.
Mirrors predict_hits.py. Uses Negative Binomial distribution for TB
because total bases has higher variance than hits (HR tail risk).

Writes to model_predictions with market_type='player_prop', prop_type='total_bases'.
"""
import math
import pandas as pd
import joblib
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from scipy.stats import poisson, nbinom
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.predict_tb")
ET  = ZoneInfo("America/New_York")

RECENCY_WEIGHT  = 0.60
CI_Z            = 1.0
# Negative binomial dispersion param for TB (empirically ~0.6-0.7 for MLB)
NB_DISPERSION   = 0.65

FEATURE_COLS = [
    "tb_last_7g", "tb_last_15g", "tb_season_avg",
    "batter_hand", "sp_hand",
    "slg_vs_hand", "obp_vs_hand", "wrc_plus_vs_hand",
    "opp_sp_era", "opp_sp_xera", "opp_sp_fip", "opp_sp_era_xera_gap",
    "opp_sp_swstr_rate", "opp_sp_k_rate", "opp_sp_bb_rate", "opp_sp_gb_rate",
    "park_runs_factor", "park_hr_factor",
    "temp_f", "wind_out_speed", "wind_in_speed",
    "batting_order", "is_home",
]

def get_db():
    return psycopg2.connect(DATABASE_URL)

def _blend_tb_mean(season_slg, rolling_7g_tb):
    """Blend season SLG-based TB rate with recent 7g rolling TB/game."""
    # Season TB/game proxy: SLG × 3.8 AB/game
    season_tbpg  = float(season_slg or 0.40) * 3.8
    recent_tbpg  = float(rolling_7g_tb) if rolling_7g_tb is not None else season_tbpg
    return RECENCY_WEIGHT * recent_tbpg + (1 - RECENCY_WEIGHT) * season_tbpg

def _nb_p_over(mu: float, line: float, dispersion: float = NB_DISPERSION) -> float:
    """
    Negative binomial P(TB > line).
    NB parameterisation: mean=mu, var=mu + mu²/r where r=dispersion.
    scipy nbinom uses (n=r, p=r/(r+mu)).
    """
    r = dispersion
    p = r / (r + mu)
    floored = math.floor(line)
    return float(1 - nbinom.cdf(floored, r, p))

def predict_tb_for_today():
    today = datetime.now(ET).strftime("%Y-%m-%d")

    try:
        bundle = joblib.load("mlb/models/tb_model.joblib")
    except FileNotFoundError:
        log.warning("predict_tb: tb_model.joblib not found — using blend-only fallback")
        bundle = None

    conn = get_db()
    df = pd.read_sql("""
        SELECT player_id, game_id, player_name,
               tb_last_7g, tb_last_15g, tb_season_avg,
               batter_hand, sp_hand,
               slg_vs_hand, obp_vs_hand, wrc_plus_vs_hand,
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
        log.info("predict_tb: no batter features for today")
        return

    # Blend-based lambda
    df["tb_blend"] = df.apply(
        lambda r: _blend_tb_mean(r["tb_season_avg"], r["tb_last_7g"]), axis=1
    )

    # XGBoost prediction
    if bundle:
        model     = bundle["model"]
        feat_cols = bundle["features"]
        df_feat   = df.copy()
        for col in feat_cols:
            if col not in df_feat.columns:
                df_feat[col] = 0
        X = df_feat[feat_cols].fillna(0)
        X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
        df["tb_xgb"]        = model.predict(X)
        df["tb_mean_pred"]  = 0.65 * df["tb_xgb"] + 0.35 * df["tb_blend"]
    else:
        df["tb_mean_pred"] = df["tb_blend"]

    # NB CI (higher variance than Poisson for TB)
    df["tb_pred_lo"] = (df["tb_mean_pred"] - CI_Z * df["tb_mean_pred"].apply(
        lambda x: math.sqrt(max(x, 0.01) * (1 + max(x, 0.01) / NB_DISPERSION))
    )).clip(lower=0)
    df["tb_pred_hi"] =  df["tb_mean_pred"] + CI_Z * df["tb_mean_pred"].apply(
        lambda x: math.sqrt(max(x, 0.01) * (1 + max(x, 0.01) / NB_DISPERSION))
    )

    conn = get_db()
    cur  = conn.cursor()
    now  = datetime.utcnow()

    for _, row in df.iterrows():
        lam = float(row["tb_mean_pred"])
        cur.execute("""
            INSERT INTO model_predictions (
                game_id, player_id, player_name,
                market_type, prop_type,
                model_mean, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (game_id, player_id, market_type, prop_type, DATE(created_at))
            DO UPDATE SET
                model_mean  = EXCLUDED.model_mean,
                player_name = EXCLUDED.player_name,
                created_at  = EXCLUDED.created_at
        """, (
            row["game_id"], int(row["player_id"]),
            row.get("player_name"),
            "player_prop", "total_bases",
            lam, now
        ))

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_tb_for_today: wrote {len(df)} TB predictions")
