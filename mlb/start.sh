#!/bin/bash
export DATABASE_URL="postgresql://postgres:cgktPPerQvmdJMyAuYcMAxkUsqoniycZ@postgres.railway.internal:5432/railway"
cd /app
python -m mlb.startup || true
exec uvicorn mlb.api.main:app --host 0.0.0.0 --port $PORT
