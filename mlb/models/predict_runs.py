import pandas as pd
import joblib
import psycopg2
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.models.predict_runs")
ET = ZoneInfo("America/New_York")

def get_db():
    return psycopg2.connect(DATABASE_URL)

def predict_runs_for_today():
    conn = get_db()
    today = datetime.now(ET).strftime("%Y-%m-%d")

    try:
        bundle = joblib.load("mlb/models/run_model.joblib")
    except FileNotFoundError:
        log.error("predict_runs_for_today: run_model.joblib not found — run train_run_model first")
        return

    model = bundle["model"]
    feature_cols = bundle["features"]

    df = pd.read_sql("""
        SELECT
            game_id, team_id, is_home,
            team_wrc_plus_vs_hand, team_iso_vs_hand, team_obp_vs_hand,
            opp_sp_xfip, opp_sp_fip, opp_sp_k_minus_bb, opp_sp_gb_rate,
            opp_bp_xfip, opp_bp_ip_last_3d,
            park_runs_factor, temp_f, wind_speed_mph,
            start_time_bucket, league
        FROM game_run_data
        WHERE DATE(date) = %s
    """, conn, params=(today,))
    conn.close()

    if df.empty:
        log.info("predict_runs_for_today: no rows for today")
        return

    df["start_time_bucket"] = df["start_time_bucket"].fillna("day")
    df["league"] = df["league"].fillna("AL")
    df = pd.get_dummies(df, columns=["start_time_bucket", "league"], drop_first=True)
    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0
    X = df[feature_cols].fillna(0)
    df["run_mean_pred"] = model.predict(X)

    game_means = {}
    for _, row in df.iterrows():
        gid = row["game_id"]
        if gid not in game_means:
            game_means[gid] = {"home": None, "away": None}
        if row["is_home"] == 1:
            game_means[gid]["home"] = float(row["run_mean_pred"])
        else:
            game_means[gid]["away"] = float(row["run_mean_pred"])

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()
    for gid, vals in game_means.items():
        if vals["home"] is None or vals["away"] is None:
            continue
        cur.execute("""
            INSERT INTO model_predictions (
                game_id, market_type, prop_type,
                model_mean_home, model_mean_away, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s)
        """, (gid, "game", "runs", vals["home"], vals["away"], now))
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_runs_for_today: wrote run means for {len(game_means)} games")
