"""startup.py — BetIntel MLB startup pipeline.

Step 0  : DB migrations          (HARD — failure aborts)
Step 1  : Schedule
Step 2  : Lineups
Step 2.5: Pitcher stats          (xERA / FIP / ERA — Rank 1)
Step 3  : Odds
Step 4  : Bullpen
Step 5  : Weather
Step 6  : K features
Step 7  : Run features
Step 8  : Train K model
Step 9  : Train run model
Step 10 : Predict K
Step 11 : Predict runs
Step 12 : K edges
Step 13 : Run edges
Step 14 : Analyst agent
Step 15 : Fetch yesterday's results   (Rank 2 — ground truth)
Step 16 : Run calibration loop        (Rank 2 — Brier / ROI / MAE / drift)
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

    # ── Step 0: Migrations (HARD) ──────────────────────────────────────────
    try:
        from mlb.migrate import run_migrations
        run_migrations()
        log.info("startup: step 0 — migrations ✅")
    except Exception as e:
        log.critical(f"startup: step 0 — migrations FAILED: {e}")
        return

    # ── Steps 1–16: Soft ──────────────────────────────────────────────────
    from mlb.ingestion.schedule       import fetch_schedule_for_today
    from mlb.ingestion.lineups        import fetch_lineups_for_today
    from mlb.ingestion.pitcher_stats  import fetch_pitcher_stats
    from mlb.ingestion.odds           import fetch_odds
    from mlb.ingestion.bullpen        import fetch_bullpen_stats
    from mlb.ingestion.weather        import fetch_weather_for_today
    from mlb.ingestion.results        import fetch_results_for_today          # Rank 2
    from mlb.features.build_k_features   import build_k_features_for_date
    from mlb.features.build_run_features import build_run_features_for_date
    from mlb.models.train_k_model    import train_k_model
    from mlb.models.train_run_model  import train_run_model
    from mlb.models.predict_k        import predict_k_for_today
    from mlb.models.predict_runs     import predict_runs_for_today
    from mlb.models.compute_edges    import compute_k_edges, compute_run_edges
    from mlb.analyst.analyst_agent   import run_analyst_agent_for_today
    from mlb.calibration.run_calibration import run_calibration               # Rank 2

    soft_step("1   — schedule",         fetch_schedule_for_today)
    soft_step("2   — lineups",          fetch_lineups_for_today)
    soft_step("2.5 — pitcher stats",    fetch_pitcher_stats)
    soft_step("3   — odds",             fetch_odds)
    soft_step("4   — bullpen",          fetch_bullpen_stats)
    soft_step("5   — weather",          fetch_weather_for_today)
    soft_step("6   — k features",       build_k_features_for_date, today)
    soft_step("7   — run features",     build_run_features_for_date, today)
    soft_step("8   — train k",          train_k_model)
    soft_step("9   — train runs",       train_run_model)
    soft_step("10  — predict k",        predict_k_for_today)
    soft_step("11  — predict runs",     predict_runs_for_today)
    soft_step("12  — k edges",          compute_k_edges)
    soft_step("13  — run edges",        compute_run_edges)
    soft_step("14  — analyst",          run_analyst_agent_for_today)
    soft_step("15  — fetch results",    fetch_results_for_today)              # Rank 2
    soft_step("16  — calibration",      run_calibration)                      # Rank 2

    log.info(f"startup: pipeline complete for {today}")
