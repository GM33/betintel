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
            COALESCE(team_slg_recent, 0) AS team_slg_recent,
            COALESCE(opp_slg_recent, 0) AS opp_slg_recent,
            COALESCE(sp_era, 0) AS sp_era,
            COALESCE(sp_proj_era, opp_sp_xfip, opp_sp_fip, 0) AS sp_proj_era,
            COALESCE(sp_era_gap, COALESCE(sp_proj_era, opp_sp_xfip, opp_sp_fip, 0) - COALESCE(sp_era, 0), 0) AS sp_era_gap,
            COALESCE(bp_fatigue_idx, opp_bp_ip_last_3d, 0) AS bp_fatigue_idx,
            COALESCE(park_total_adjustment, park_runs_factor - 1.0, 0) AS park_total_adjustment,
            COALESCE(underdog_confidence_flag, 0) AS underdog_confidence_flag,
            start_time_bucket, league
        FROM game_run_data
        WHERE DATE(date) = %s
    """, conn, params=(today,))
    conn.close()

    if df.empty:
        log.info("predict_runs_for_today: no rows for today")
        return

    df["team_slg_delta"] = df["team_slg_recent"] - df["opp_slg_recent"]
    df["start_time_bucket"] = df["start_time_bucket"].fillna("day")
    df["league"] = df["league"].fillna("AL")
    df = pd.get_dummies(df, columns=["start_time_bucket", "league"], drop_first=True)

    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0

    X = df[feature_cols].fillna(0)
    df["run_mean_pred"] = model.predict(X)

    game_means = {}
    game_meta = {}
    for _, row in df.iterrows():
        gid = row["game_id"]
        if gid not in game_means:
            game_means[gid] = {"home": None, "away": None}
            game_meta[gid] = {
                "max_sp_era_gap": 0.0,
                "max_bp_fatigue_idx": 0.0,
                "park_total_adjustment": 0.0,
                "max_underdog_confidence_flag": 0,
                "max_team_slg_delta": 0.0,
            }
        if row["is_home"] == 1:
            game_means[gid]["home"] = float(row["run_mean_pred"])
        else:
            game_means[gid]["away"] = float(row["run_mean_pred"])

        game_meta[gid]["max_sp_era_gap"] = max(game_meta[gid]["max_sp_era_gap"], float(row.get("sp_era_gap", 0) or 0))
        game_meta[gid]["max_bp_fatigue_idx"] = max(game_meta[gid]["max_bp_fatigue_idx"], float(row.get("bp_fatigue_idx", 0) or 0))
        game_meta[gid]["park_total_adjustment"] = float(row.get("park_total_adjustment", 0) or 0)
        game_meta[gid]["max_underdog_confidence_flag"] = max(game_meta[gid]["max_underdog_confidence_flag"], int(row.get("underdog_confidence_flag", 0) or 0))
        game_meta[gid]["max_team_slg_delta"] = max(game_meta[gid]["max_team_slg_delta"], abs(float(row.get("team_slg_delta", 0) or 0)))

    conn = get_db()
    cur = conn.cursor()
    now = datetime.utcnow()
    for gid, vals in game_means.items():
        if vals["home"] is None or vals["away"] is None:
            continue

        total_mean = vals["home"] + vals["away"]
        meta = game_meta.get(gid, {})

        key_driver_parts = []
        if meta.get("max_sp_era_gap", 0) >= 1.5:
            key_driver_parts.append(f"xERA gap {meta['max_sp_era_gap']:.2f}")
        if meta.get("max_bp_fatigue_idx", 0) >= 12:
            key_driver_parts.append(f"bullpen fatigue {meta['max_bp_fatigue_idx']:.1f} IP/3d")
        if abs(meta.get("park_total_adjustment", 0)) >= 0.05:
            key_driver_parts.append(f"park adj {meta['park_total_adjustment']:+.2f}")
        if meta.get("max_underdog_confidence_flag", 0) == 1:
            key_driver_parts.append("road dog value flag")
        if meta.get("max_team_slg_delta", 0) >= 0.015:
            key_driver_parts.append(f"SLG delta {meta['max_team_slg_delta']:+.3f}")
        feature_summary = "; ".join(key_driver_parts) if key_driver_parts else None

        cur.execute("""
            INSERT INTO model_predictions (
                game_id, market_type, prop_type,
                model_mean_home, model_mean_away, model_mean,
                key_driver, created_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            gid, "game", "runs", vals["home"], vals["away"], total_mean,
            feature_summary, now
        ))
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"predict_runs_for_today: wrote run means for {len(game_means)} games")
