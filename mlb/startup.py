"""startup.py — BetIntel MLB startup pipeline.

Called from the FastAPI lifespan hook on every Railway deploy.
Step 0 (migrations) runs synchronously and MUST succeed before the
pipeline continues. All other steps are soft — failures are logged
but never crash uvicorn.

Pipeline order (dependency-ordered):
  0.  DB migrations          (HARD)
  1.  Schedule
  2.  Lineups
  2.5 Pitcher stats          (xERA, xFIP, FIP, ERA — Rank 1 upgrade)
  3.  Odds
  4.  Bullpen
  5.  Weather
  6.  K features
  7.  Run features
  8.  Train K model
  9.  Train run model
  10. Predict K
  11. Predict runs
  12. K edges
  13. Run edges
  14. Analyst agent
"""
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger("betintel.startup")
ET  = ZoneInfo("America/New_York")

def soft_step(name: str, fn, *args, **kwargs):
    """Run fn(*args, **kwargs); log but never raise on failure."""
    try:
        fn(*args, **kwargs)
        log.info(f"startup: {name} ✅")
    except Exception as e:
        log.error(f"startup: {name} ❌ — {e}")

def run_startup_pipeline():
    today = datetime.now(ET).strftime("%Y-%m-%d")

    # ──────────────────────────────────────────────────────────────
    # STEP 0 — DB migrations (HARD — failure aborts pipeline)
    # ──────────────────────────────────────────────────────────────
    try:
        from mlb.migrate import run_migrations
        run_migrations()
        log.info("startup: step 0 — migrations ✅")
    except Exception as e:
        log.critical(f"startup: step 0 — migrations FAILED: {e}")
        return

    # ──────────────────────────────────────────────────────────────
    # STEPS 1–14 — Soft (failure logged, pipeline continues)
    # ──────────────────────────────────────────────────────────────
    from mlb.ingestion.schedule       import fetch_schedule_for_today
    from mlb.ingestion.lineups        import fetch_lineups_for_today
    from mlb.ingestion.pitcher_stats  import fetch_pitcher_stats        # Rank 1
    from mlb.ingestion.odds           import fetch_odds
    from mlb.ingestion.bullpen        import fetch_bullpen_stats
    from mlb.ingestion.weather        import fetch_weather_for_today
    from mlb.features.build_k_features   import build_k_features_for_date
    from mlb.features.build_run_features import build_run_features_for_date
    from mlb.models.train_k_model    import train_k_model
    from mlb.models.train_run_model  import train_run_model
    from mlb.models.predict_k        import predict_k_for_today
    from mlb.models.predict_runs     import predict_runs_for_today
    from mlb.models.compute_edges    import compute_k_edges, compute_run_edges
    from mlb.analyst.analyst_agent   import run_analyst_agent_for_today

    soft_step("1  — schedule",        fetch_schedule_for_today)
    soft_step("2  — lineups",         fetch_lineups_for_today)
    soft_step("2.5— pitcher stats",   fetch_pitcher_stats)          # Rank 1: xERA/FIP live
    soft_step("3  — odds",            fetch_odds)
    soft_step("4  — bullpen",         fetch_bullpen_stats)
    soft_step("5  — weather",         fetch_weather_for_today)
    soft_step("6  — k features",      build_k_features_for_date, today)
    soft_step("7  — run features",    build_run_features_for_date, today)
    soft_step("8  — train k",         train_k_model)
    soft_step("9  — train runs",      train_run_model)
    soft_step("10 — predict k",       predict_k_for_today)
    soft_step("11 — predict runs",    predict_runs_for_today)
    soft_step("12 — k edges",         compute_k_edges)
    soft_step("13 — run edges",       compute_run_edges)
    soft_step("14 — analyst",         run_analyst_agent_for_today)

    log.info(f"startup: pipeline complete for {today}")
