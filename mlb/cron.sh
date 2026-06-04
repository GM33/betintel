#!/bin/bash
echo ">>> BetIntel cron starting..."

while true; do
    echo ">>> [$(date -u)] Running line_snapshots..."
    python -m mlb.ingestion.line_snapshots

    echo ">>> [$(date -u)] Running evaluate_line_alerts..."
    python -m mlb.alerts.evaluate_line_alerts

    echo ">>> [$(date -u)] Cycle complete. Sleeping 300s..."
    sleep 300
done
