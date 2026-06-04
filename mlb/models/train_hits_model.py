"""train_hits_model.py

XGBoost regressor for batter hits prop model.
Mirrors train_k_model.py exactly. Trains on batter_prop_features
where actual_hits IS NOT NULL (post-game backfill).

Saved to: mlb/models/hits_model.joblib
"""
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor
import joblib
import psycopg2
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.train_hits")

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

def train_hits_model(start_season: int = 2022):
    conn = get_db()
    df = pd.read_sql("""
        SELECT {cols}, actual_hits
        FROM batter_prop_features
        WHERE EXTRACT(YEAR FROM date) >= %(season)s
          AND actual_hits IS NOT NULL
    """.format(cols=", ".join(FEATURE_COLS)), conn, params={"season": start_season})
    conn.close()

    if df.empty or len(df) < 50:
        log.warning(f"train_hits_model: insufficient data ({len(df)} rows) — skipping")
        return None, []

    X = df[FEATURE_COLS].fillna(0)
    X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
    y = df["actual_hits"]

    X_train, X_valid, y_train, y_valid = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    model = XGBRegressor(
        n_estimators=500, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        objective="reg:squarederror", n_jobs=4
    )
    model.fit(X_train, y_train,
              eval_set=[(X_valid, y_valid)],
              verbose=False)
    mae = mean_absolute_error(y_valid, model.predict(X_valid))
    log.info(f"hits model MAE on validation: {mae:.3f}")

    joblib.dump({"model": model, "features": FEATURE_COLS}, "mlb/models/hits_model.joblib")
    log.info("hits_model.joblib saved")
    return model, FEATURE_COLS
