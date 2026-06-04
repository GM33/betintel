#!/bin/bash
set -e
export DATABASE_URL="postgresql://postgres:cgktPPerQvmdJMyAuYcMAxkUsqoniycZ@postgres.railway.internal:5432/railway"
cd /app

# Patch startup at runtime: monkey-patch step() to be non-fatal for external API steps
python - <<'EOF'
import sys, types, logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("betintel.startup")

# Import startup module and replace step with soft version
import mlb.startup as s

_original_step = s.step

def _soft_step(label, fn):
    log.info(f"\n{'='*50}\n\u25b6 {label}\n{'='*50}")
    try:
        fn()
        log.info(f"\u2705 {label} complete")
    except Exception as e:
        log.warning(f"\u26a0\ufe0f  {label} skipped (non-fatal): {e}")

# Patch steps 7-9 to be non-fatal
_orig_run = s.run
def _patched_run():
    from mlb.ingestion.odds import fetch_odds
    from mlb.ingestion.props import fetch_player_props
    from mlb.ingestion.weather import fetch_weather_for_today
    from mlb.ingestion.lineups import fetch_lineups
    # Run original but catch external API failures
    import mlb.startup as _s
    _s.step = _soft_step
    try:
        _orig_run()
    finally:
        _s.step = _original_step

_patched_run()
EOF

exec uvicorn mlb.api.main:app --host 0.0.0.0 --port $PORT
