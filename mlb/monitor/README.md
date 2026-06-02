# BetIntel MLB Odds Monitor

## What It Does

Polls live market odds every 5 minutes and fires an alert whenever a game's
market-implied probability deviates **≥ 5%** from the model's fair probability.

Alerts are written to `edge_alerts` (Postgres) and surfaced via the
`/monitor/alerts/active` API endpoint for the dashboard notification banner.

## Architecture

```
APScheduler (runner.py)
  └── run_odds_monitor()  [every 5 min]
        ├── fetch_odds("live_poll")          → market_snapshots
        ├── [if game_context changed]
        │     ├── fetch_lineups()
        │     ├── predict_k_for_today()
        │     ├── predict_runs_for_today()
        │     ├── compute_k_edges()
        │     ├── compute_run_edges()
        │     └── run_analyst_agent_for_today()
        ├── compare model_predictions vs market_snapshots
        └── INSERT edge_alerts WHERE edge >= 0.05

FastAPI (main.py)
  └── /monitor/alerts/active     → dashboard banner feed
  └── /monitor/alerts/log        → rolling log with pagination
  └── /monitor/alerts/{id}       → single alert detail
  └── /monitor/alerts/{id}/resolve → manual dismiss
```

## Wiring Into main.py

```python
# In mlb/api/main.py, add:
from mlb.api.monitor_routes import router as monitor_router
app.include_router(monitor_router, prefix="/monitor")
```

## Wiring Into runner.py

```python
# In mlb/scheduler/runner.py, add:
from mlb.monitor.odds_monitor import run_odds_monitor
scheduler.add_job(run_odds_monitor, "interval", minutes=5, id="odds_monitor")
```

## Alert Lifecycle

| Status     | Meaning                                           |
|------------|---------------------------------------------------|
| `ACTIVE`   | Edge still open, alert is live on dashboard       |
| `RESOLVED` | Edge closed (line moved) or manually dismissed    |
| `EXPIRED`  | Game started; alert no longer actionable          |

## Tuning

| Parameter          | Default | Location            | Notes                        |
|--------------------|---------|---------------------|------------------------------|
| `EDGE_THRESHOLD`   | 0.05    | odds_monitor.py     | 5% deviation = trigger       |
| `POLL_INTERVAL_MIN`| 5       | runner.py job param | How often monitor runs       |
| `MIN_REFIRE_MINUTES`| 30     | odds_monitor.py     | Suppress duplicate alerts    |

## Database

Run migration before deploying:
```bash
psql $DATABASE_URL -f mlb/db/migrations/004_edge_alerts.sql
```
