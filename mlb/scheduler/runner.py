from apscheduler.schedulers.blocking import BlockingScheduler
import logging

from mlb.ingestion.schedule import fetch_schedule
from mlb.ingestion.lineups import fetch_lineups
from mlb.ingestion.bullpen import fetch_bullpen_usage
from mlb.ingestion.odds import fetch_odds
from mlb.ingestion.props import fetch_player_props
from mlb.ingestion.results import fetch_results
from mlb.ingestion.weather import fetch_weather_for_today
from mlb.models.predict_k import predict_k_for_today
from mlb.models.predict_runs import predict_runs_for_today
from mlb.models.compute_edges import compute_k_edges, compute_run_edges
from mlb.analyst.analyst_agent import run_analyst_agent_for_today
from mlb.calibration.calibrate_k import run_calibration_update_k
from mlb.calibration.calibrate_runs import run_calibration_update_runs

logging.basicConfig(level=logging.INFO)
scheduler = BlockingScheduler(timezone="America/New_York")

# Morning batch
scheduler.add_job(fetch_bullpen_usage,             "cron", hour=8,  minute=0)
scheduler.add_job(fetch_schedule,                  "cron", hour=9,  minute=0)
scheduler.add_job(lambda: fetch_odds("open"),      "cron", hour=10, minute=30)
scheduler.add_job(fetch_schedule,                  "cron", hour=11, minute=0)
scheduler.add_job(fetch_player_props,              "cron", hour=12, minute=0)

# Pre-game batch (day games T-2hr proxy)
scheduler.add_job(fetch_weather_for_today,         "cron", hour=13, minute=0)
scheduler.add_job(lambda: fetch_odds("pre_game"),  "cron", hour=13, minute=5)
scheduler.add_job(fetch_lineups,                   "cron", hour=13, minute=10)
scheduler.add_job(predict_k_for_today,             "cron", hour=13, minute=20)
scheduler.add_job(predict_runs_for_today,          "cron", hour=13, minute=25)
scheduler.add_job(compute_k_edges,                 "cron", hour=13, minute=30)
scheduler.add_job(compute_run_edges,               "cron", hour=13, minute=35)
scheduler.add_job(run_analyst_agent_for_today,     "cron", hour=13, minute=45)

# Evening pre-game batch (T-30min for night games)
scheduler.add_job(lambda: fetch_odds("final_pre"), "cron", hour=18, minute=45)
scheduler.add_job(fetch_lineups,                   "cron", hour=18, minute=50)
scheduler.add_job(run_analyst_agent_for_today,     "cron", hour=18, minute=55)

# Post-game calibration
scheduler.add_job(fetch_results,                   "cron", hour=23, minute=30)
scheduler.add_job(run_calibration_update_k,        "cron", hour=23, minute=50)
scheduler.add_job(run_calibration_update_runs,     "cron", hour=23, minute=55)

if __name__ == "__main__":
    logging.info("BetIntel MLB scheduler starting...")
    scheduler.start()
