#!/bin/bash
cd /app
echo ">>> Running migrations..."
python -m mlb.migrate
if [ $? -ne 0 ]; then
  echo ">>> Migration failed — aborting startup"
  exit 1
fi
echo ">>> Migrations complete. Starting server..."
exec uvicorn mlb.api.main:app --host 0.0.0.0 --port $PORT
