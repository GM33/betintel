"""startup.py — BetIntel MLB startup pipeline.

Full 20-step pipeline (dependency-ordered):

  0   DB migrations              (HARD)
  1   Schedule
  2   Lineups
  2.5 Pitcher stats              (Rank 1: xERA/FIP/ERA)
  3   Odds
  4   Bullpen
  5   Weather
  6   K features
  6.5 Batter prop features       (Rank 3: hits + TB features)
  7   Run features
  8   Train K model
  8.5 Train hits model           (Rank 3)
  8.6 Train TB model             (Rank 3)
  9   Train run model
  10  Predict K
  10.5 Predict hits              (Rank 3)
  10.6 Predict TB                (Rank 3)
  11  Predict runs
  12  K edges
  12.5 Hits edges                (Rank 3)
  12.6 TB edges                  (Rank 3)
  13  Run edges
  14  Analyst agent
  15  Fetch results              (Rank 2)
  16  Calibration loop           (Rank 2)
"""
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger("betintel.startup")
ET  = ZoneInfo("America/New_York")

def soft_step(name: str, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
        log.info(f"startup: {name} ✅")
    except Exception as e:
        log.error(f"startup: {name} ❌ — {e}")

def run_startup_pipeline():
    today = datetime.now(ET).strftime("%Y-%m-%d")

    # ── Step 0: Migrations (HARD) ─────────────────────────────────────────
    try:
        from mlb.migrate import run_migrations
        run_migrations()
        log.info("startup: step 0 — migrations ✅")
    except Exception as e:
        log.critical(f"startup: step 0 — migrations FAILED: {e}")
        return

    # ── Steps 1–16: Soft ──────────────────────────────────────────────────
    from mlb.ingestion.schedule            import fetch_schedule_for_today
    from mlb.ingestion.lineups             import fetch_lineups_for_today
    from mlb.ingestion.pitcher_stats       import fetch_pitcher_stats
    from mlb.ingestion.odds                import fetch_odds
    from mlb.ingestion.bullpen             import fetch_bullpen_stats
    from mlb.ingestion.weather             import fetch_weather_for_today
    from mlb.ingestion.results             import fetch_results_for_today
    from mlb.features.build_k_features          import build_k_features_for_date
    from mlb.features.build_batter_prop_features import build_batter_prop_features_for_date
    from mlb.features.build_run_features         import build_run_features_for_date
    from mlb.models.train_k_model          import train_k_model
    from mlb.models.train_hits_model       import train_hits_model
    from mlb.models.train_tb_model         import train_tb_model
    from mlb.models.train_run_model        import train_run_model
    from mlb.models.predict_k             import predict_k_for_today
    from mlb.models.predict_hits          import predict_hits_for_today
    from mlb.models.predict_tb            import predict_tb_for_today
    from mlb.models.predict_runs          import predict_runs_for_today
    from mlb.models.compute_edges         import compute_k_edges, compute_run_edges
    from mlb.models.compute_batter_edges  import compute_hits_edges, compute_tb_edges
    from mlb.analyst.analyst_agent        import run_analyst_agent_for_today
    from mlb.calibration.run_calibration  import run_calibration

    soft_step("1   — schedule",             fetch_schedule_for_today)
    soft_step("2   — lineups",              fetch_lineups_for_today)
    soft_step("2.5 — pitcher stats",        fetch_pitcher_stats)
    soft_step("3   — odds",                 fetch_odds)
    soft_step("4   — bullpen",              fetch_bullpen_stats)
    soft_step("5   — weather",              fetch_weather_for_today)
    soft_step("6   — k features",           build_k_features_for_date, today)
    soft_step("6.5 — batter prop features", build_batter_prop_features_for_date, today)
    soft_step("7   — run features",         build_run_features_for_date, today)
    soft_step("8   — train k",              train_k_model)
    soft_step("8.5 — train hits",           train_hits_model)
    soft_step("8.6 — train tb",             train_tb_model)
    soft_step("9   — train runs",           train_run_model)
    soft_step("10  — predict k",            predict_k_for_today)
    soft_step("10.5— predict hits",         predict_hits_for_today)
    soft_step("10.6— predict tb",           predict_tb_for_today)
    soft_step("11  — predict runs",         predict_runs_for_today)
    soft_step("12  — k edges",              compute_k_edges)
    soft_step("12.5— hits edges",           compute_hits_edges)
    soft_step("12.6— tb edges",             compute_tb_edges)
    soft_step("13  — run edges",            compute_run_edges)
    soft_step("14  — analyst",              run_analyst_agent_for_today)
    soft_step("15  — fetch results",        fetch_results_for_today)
    soft_step("16  — calibration",          run_calibration)

    log.info(f"startup: pipeline complete for {today}")
