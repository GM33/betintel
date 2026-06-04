import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor
import joblib
import psycopg2
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.train_run")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def train_run_model(start_season: int = 2021):
    conn = get_db()
    df = pd.read_sql("""
        SELECT
            game_id, team_id, is_home, date, runs_scored,
            team_wrc_plus_vs_hand, team_iso_vs_hand, team_obp_vs_hand,
            opp_sp_xfip, opp_sp_fip, opp_sp_k_minus_bb, opp_sp_gb_rate,
            opp_bp_xfip, opp_bp_ip_last_3d,
            park_runs_factor, temp_f, wind_speed_mph,
            start_time_bucket, league
        FROM game_run_data
        WHERE EXTRACT(YEAR FROM date) >= %s
          AND runs_scored IS NOT NULL
    """, conn, params=(start_season,))
    conn.close()

    if df.empty:
        log.warning("train_run_model: no training data found")
        return None, []

    df["start_time_bucket"] = df["start_time_bucket"].fillna("day")
    df["league"] = df["league"].fillna("AL")
    df = pd.get_dummies(df, columns=["start_time_bucket", "league"], drop_first=True)
    feature_cols = [c for c in df.columns if c not in ("game_id", "team_id", "date", "runs_scored")]

    X = df[feature_cols].fillna(0)
    # Coerce any object columns to numeric (strings from Postgres TEXT columns)
    X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
    y = df["runs_scored"]

    X_train, X_valid, y_train, y_valid = train_test_split(X, y, test_size=0.2, random_state=42)

    model = XGBRegressor(
        n_estimators=600, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        objective="reg:squarederror", n_jobs=4
    )
    model.fit(X_train, y_train)
    mae = mean_absolute_error(y_valid, model.predict(X_valid))
    log.info(f"Run model MAE on validation: {mae:.3f}")

    joblib.dump({"model": model, "features": feature_cols}, "mlb/models/run_model.joblib")
    return model, feature_cols
