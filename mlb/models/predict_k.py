import pandas as pd
import joblib
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.predict_k")
ET = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

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
            ump_k_rate_diff
        FROM pitcher_k_games
        WHERE DATE(date) = %s
    """, conn, params=(today,))

    conn.close()
    if df.empty:
        log.info("predict_k_for_today: no rows for today")
        return

    df["p_hand"] = df["p_hand"].fillna(1)
    df = pd.get_dummies(df, columns=["g_park_id"], drop_first=True)
    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0
    X = df[feature_cols].fillna(0)
    df["k_mean_pred"] = model.predict(X)

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()
    for _, row in df.iterrows():
        cur.execute("""
            INSERT INTO model_predictions (
                game_id, player_id, market_type, prop_type, model_mean, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s)
        """, (
            row["game_id"], int(row["pitcher_id"]),
            "player_prop", "k_strikeouts",
            float(row["k_mean_pred"]), now
        ))
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_k_for_today: wrote {len(df)} predictions")
