import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor
import joblib
import psycopg2
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.train_k")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def train_k_model(start_season: int = 2021):
    conn = get_db()
    df = pd.read_sql("""
        SELECT
            game_id, date, pitcher_id, k_outs,
            p_k_rate, p_k_rate_vs_hand, p_bb_rate, p_swstr_rate,
            p_ip_per_start, p_hand,
            opp_k_rate_vs_hand, opp_bb_rate_vs_hand,
            home_away, g_park_id,
            bp_ip_last_3d, bp_relievers_used_last_3d,
            ump_k_rate_diff
        FROM pitcher_k_games
        WHERE EXTRACT(YEAR FROM date) >= %s
          AND k_outs IS NOT NULL
    """, conn, params=(start_season,))
    conn.close()

    if df.empty:
        log.warning("train_k_model: no training data found")
        return None, []

    df["p_hand"] = df["p_hand"].fillna(1)
    df = pd.get_dummies(df, columns=["g_park_id"], drop_first=True)
    feature_cols = [c for c in df.columns if c not in ("game_id", "date", "pitcher_id", "k_outs")]

    X = df[feature_cols].fillna(0)
    # Coerce any object columns to numeric (strings from Postgres TEXT columns)
    X = X.apply(pd.to_numeric, errors="coerce").fillna(0)
    y = df["k_outs"]

    X_train, X_valid, y_train, y_valid = train_test_split(X, y, test_size=0.2, random_state=42)

    model = XGBRegressor(
        n_estimators=500, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        objective="reg:squarederror", n_jobs=4
    )
    model.fit(X_train, y_train)
    mae = mean_absolute_error(y_valid, model.predict(X_valid))
    log.info(f"K model MAE on validation: {mae:.3f}")

    joblib.dump({"model": model, "features": feature_cols}, "mlb/models/k_model.joblib")
    return model, feature_cols
