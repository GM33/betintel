"""Startup pipeline — runs in a background thread via mlb/api/main.py lifespan.

Design:
- Steps 1 (schema) and 2 (seed) are guarded by idempotency checks so re-runs
  on Railway restart never double-apply migrations or re-seed existing data.
- Uvicorn + /health return 200 immediately; pipeline_ready flips to True when
  all 10 steps complete.
- Any step failure is logged but does NOT crash the web server.
"""
import os
import logging
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("betintel.startup")


def step(label, fn):
    log.info(f"\n{'='*50}\n\u25b6 {label}\n{'='*50}")
    try:
        fn()
        log.info(f"\u2705 {label} complete")
    except Exception as e:
        log.error(f"\u274c {label} failed: {e}")
        raise


def _schema_already_applied():
    """Return True if the DB already has the model_predictions table."""
    try:
        import psycopg2
        db_url = os.environ["DATABASE_URL"].strip()
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name   = 'model_predictions'
            )
        """)
        exists = cur.fetchone()[0]
        cur.close()
        conn.close()
        return exists
    except Exception:
        return False


def _seed_already_done():
    """Return True if historical seed data exists (at least 1 row in game_context)."""
    try:
        import psycopg2
        db_url = os.environ["DATABASE_URL"].strip()
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute("SELECT EXISTS (SELECT 1 FROM game_context LIMIT 1)")
        exists = cur.fetchone()[0]
        cur.close()
        conn.close()
        return exists
    except Exception:
        return False


def run():
    from mlb.migrate import run_migrations
    from mlb.seed.seed_historical import seed_all
    from mlb.models.train_k_model import train_k_model
    from mlb.models.train_run_model import train_run_model
    from mlb.ingestion.schedule import fetch_schedule
    from mlb.ingestion.bullpen import fetch_bullpen_usage
    from mlb.ingestion.odds import fetch_odds
    from mlb.ingestion.props import fetch_player_props
    from mlb.ingestion.weather import fetch_weather_for_today
    from mlb.ingestion.lineups import fetch_lineups
    from mlb.models.predict_k import predict_k_for_today
    from mlb.models.predict_runs import predict_runs_for_today
    from mlb.models.compute_edges import compute_k_edges, compute_run_edges
    from mlb.analyst.analyst_agent import run_analyst_agent_for_today

    # ── Idempotent steps ───────────────────────────────────────
    if _schema_already_applied():
        log.info("\u23e9 1/10 Schema already applied — skipping migration")
    else:
        step("1/10 Apply DB schema", run_migrations)

    if _seed_already_done():
        log.info("\u23e9 2/10 Seed data already present — skipping seed")
    else:
        step("2/10 Seed historical data (2022-2025)", seed_all)

    # ── Always re-run on deploy ──────────────────────────────────
    step("3/10 Train K strikeout model", train_k_model)
    step("4/10 Train run expectancy model", train_run_model)
    step("5/10 Fetch today's schedule", fetch_schedule)
    step("6/10 Fetch bullpen usage", fetch_bullpen_usage)
    step("7/10 Fetch odds", lambda: fetch_odds("pre_game"))
    step("8/10 Fetch K props", fetch_player_props)
    step("9/10 Fetch weather + lineups", lambda: [fetch_weather_for_today(), fetch_lineups()])
    step("10/10 Predict + compute edges + analyst", lambda: [
        predict_k_for_today(),
        predict_runs_for_today(),
        compute_k_edges(),
        compute_run_edges(),
        run_analyst_agent_for_today()
    ])

    log.info("\n\u2705 Startup complete. Cards are ready at /cards/mlb/k-props and /cards/mlb/games")


if __name__ == "__main__":
    run()
