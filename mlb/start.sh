#!/bin/bash
set -e
export DATABASE_URL="postgresql://postgres:cgktPPerQvmdJMyAuYcMAxkUsqoniycZ@postgres.railway.internal:5432/railway"
python -m mlb.startup
uvicorn mlb.api.main:app --host 0.0.0.0 --port $PORT
