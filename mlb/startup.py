"""Startup entrypoint. Run on first deploy to:
1. Apply DB schema
2. Seed historical data (last 3 seasons) from MLB StatsAPI
3. Train K and run models
4. Run today's prediction pipeline once
Then hand off to the scheduler.
"""
import os
import logging
import subprocess
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("betintel.startup")

def step(label, fn):
    log.info(f"\n{'='*50}\n▶ {label}\n{'='*50}")
    try:
        fn()
        log.info(f"✅ {label} complete")
    except Exception as e:
        log.error(f"❌ {label} failed: {e}")
        raise

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

    step("1/10 Apply DB schema", run_migrations)
    step("2/10 Seed historical data (2022-2025)", seed_all)
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

    log.info("\n✅ Startup complete. Cards are ready at /cards/mlb/k-props and /cards/mlb/games")

if __name__ == "__main__":
    run()
