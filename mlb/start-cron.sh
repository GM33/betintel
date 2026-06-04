#!/bin/bash
cd /app
echo ">>> [cron] Running migrations..."
python -m mlb.migrate
if [ $? -ne 0 ]; then
  echo ">>> [cron] Migration failed — aborting"
  exit 1
fi
echo ">>> [cron] Migrations complete. Starting cron loop..."

while true; do
    echo ">>> [$(date -u)] Running line_snapshots..."
    python -m mlb.ingestion.line_snapshots

    echo ">>> [$(date -u)] Running evaluate_line_alerts..."
    python -m mlb.alerts.evaluate_line_alerts

    echo ">>> [$(date -u)] Cycle complete. Sleeping 300s..."
    sleep 300
done
