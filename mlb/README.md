# BetIntel MLB Engine

Full automated MLB betting intelligence pipeline.

## Structure

```
mlb/
├── ingestion/       # Data ingestion from MLB StatsAPI, The Odds API, OpenWeather
├── features/        # Feature engineering jobs (pitcher K, run expectancy)
├── models/          # XGBoost model training, prediction, edge computation
├── calibration/     # Brier score, MAE, ROI calibration loops + drift detection
├── analyst/         # AI analyst agent (GPT-4o) — APPROVE/DOWNGRADE/REJECT cards
├── cards/           # Card renderers for K Props and Game cards
├── api/             # FastAPI service — /cards/mlb/k-props, /cards/mlb/games, /model-record/mlb
├── scheduler/       # APScheduler daily pipeline runner
└── db/              # schema.sql — full Postgres schema
```

## Setup

1. Install deps:
```bash
pip install -r mlb/requirements.txt
```

2. Set env vars:
```
DATABASE_URL=...
ODDS_API_KEY=...
OPENAI_API_KEY=...
WEATHER_API_KEY=...
```

3. Run DB schema:
```bash
psql $DATABASE_URL < mlb/db/schema.sql
```

4. Seed historical data from FanGraphs/Savant CSVs into `pitcher_k_games` and `game_run_data`.

5. Train models:
```bash
python -c "from mlb.models.train_k_model import train_k_model; train_k_model()"
python -c "from mlb.models.train_run_model import train_run_model; train_run_model()"
```

6. Start API:
```bash
uvicorn mlb.api.main:app --reload --port 8001
```

7. Start scheduler:
```bash
python -m mlb.scheduler.runner
```

## API Endpoints

- `GET /health` — health check
- `GET /cards/mlb/k-props?date=YYYY-MM-DD&confidence=HIGH` — K prop cards
- `GET /cards/mlb/games?date=YYYY-MM-DD&confidence=HIGH` — Game ML/total cards
- `GET /model-record/mlb` — calibration record (Brier, MAE, ROI, drift alerts)

## Pipeline Schedule (ET)

| Time | Job |
|------|-----|
| 08:00 | fetch_bullpen_usage |
| 09:00 | fetch_schedule |
| 10:30 | fetch_odds (open) |
| 11:00 | fetch_schedule (SP confirmation refresh) |
| 12:00 | fetch_player_props |
| 13:00 | fetch_weather |
| 13:05 | fetch_odds (pre_game) |
| 13:10 | fetch_lineups |
| 13:20 | predict_k_for_today |
| 13:25 | predict_runs_for_today |
| 13:30 | compute_k_edges |
| 13:35 | compute_run_edges |
| 13:45 | run_analyst_agent_for_today |
| 18:45 | fetch_odds (final_pre) |
| 18:50 | fetch_lineups |
| 18:55 | run_analyst_agent_for_today |
| 23:30 | fetch_results |
| 23:50 | run_calibration_update_k |
| 23:55 | run_calibration_update_runs |
