#!/bin/bash
set -e
cd /app
echo ">>> [$(date)] Running database migrations..."
python -m mlb.migrations.run_all
echo ">>> [$(date)] Migrations complete. Starting API..."
exec uvicorn mlb.api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
