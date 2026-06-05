from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from typing import Optional
import asyncio
import logging
import os
from datetime import datetime

log = logging.getLogger("betintel.api")
pipeline_ready = False


async def run_startup_pipeline():
    global pipeline_ready
    log.info("[startup] Background pipeline starting...")
    try:
        import subprocess
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: subprocess.run(["python", "-m", "mlb.startup"], check=True)
        )
        pipeline_ready = True
        log.info("[startup] Pipeline complete.")
    except Exception as e:
        log.error(f"[startup] Pipeline failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(run_startup_pipeline())
    yield


app = FastAPI(title="BetIntel MLB API", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_conn():
    from mlb.config import DATABASE_URL
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="DATABASE_URL not configured")
    import psycopg2
    return psycopg2.connect(DATABASE_URL)


# --- HEALTH ---

@app.get("/health")
def health():
    """Always returns 200. Never touches the DB."""
    return {
        "status": "ok",
        "service": "betintel-mlb",
        "pipeline_ready": pipeline_ready,
        "db_url_set": bool(os.environ.get("DATABASE_URL")),
        "ts": datetime.utcnow().isoformat()
    }


# --- FRONTEND API ALIASES ---

@app.get("/api/odds")
def api_odds(sport: Optional[str] = Query(default=None), date: Optional[str] = Query(default=None)):
    return get_game_cards(date=date)


@app.get("/api/nba-picks")
def api_picks(sport: Optional[str] = Query(default=None), date: Optional[str] = Query(default=None)):
    return get_k_prop_cards(date=date)


@app.get("/api/mlb-picks")
def api_mlb_picks(date: Optional[str] = Query(default=None), confidence: Optional[str] = Query(default=None)):
    return get_k_prop_cards(date=date, confidence=confidence)


@app.get("/api/wnba-picks")
def api_wnba_picks(date: Optional[str] = Query(default=None), confidence: Optional[str] = Query(default=None)):
    # Stub: wire real WNBA data source here when available
    return []


@app.get("/api/news")
def api_news(sport: Optional[str] = Query(default=None), limit: Optional[int] = Query(default=10)):
    # Stub: wire real news feed here when available
    return []


@app.get("/api/props")
def api_props(
    sport: Optional[str] = Query(default=None),
    market: Optional[str] = Query(default=None),
    date: Optional[str] = Query(default=None),
    confidence: Optional[str] = Query(default=None),
):
    if sport == "mlb" or sport is None:
        if market is None or market in ("strikeouts", "k", "k_strikeouts"):
            return get_k_prop_cards(date=date, confidence=confidence)
    return []


@app.get("/api/arb")
def api_arb(sport: Optional[str] = Query(default=None)):
    return {"sport": sport or "all", "opportunities": []}


# --- CARD ROUTES ---

@app.get("/cards/mlb/k-props")
def get_k_prop_cards(date: Optional[str] = Query(default=None), confidence: Optional[str] = Query(default=None)):
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    try:
        import psycopg2.extras
        from mlb.cards.k_card import render_k_card
        conn = get_conn()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        q = """
            SELECT mp.*, gc.venue_name, gc.game_date
            FROM model_predictions mp
            JOIN game_context gc ON mp.game_id = gc.game_id
            WHERE mp.market_type = 'player_prop'
              AND mp.prop_type = 'k_strikeouts'
              AND mp.card_decision = 'APPROVE'
              AND DATE(mp.created_at) = %s
        """
        params = [date]
        if confidence:
            q += " AND mp.confidence = %s"
            params.append(confidence)
        q += " ORDER BY mp.edge_over DESC NULLS LAST"
        cur.execute(q, params)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [render_k_card(dict(r)) for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"k-props error: {e}")
        return []


@app.get("/cards/mlb/games")
def get_game_cards(date: Optional[str] = Query(default=None), confidence: Optional[str] = Query(default=None)):
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    try:
        import psycopg2.extras
        from mlb.cards.game_card import render_game_card
        conn = get_conn()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        q = """
            SELECT mp.*, gc.venue_name, gc.game_date,
                   gc.home_team_id, gc.away_team_id
            FROM model_predictions mp
            JOIN game_context gc ON mp.game_id = gc.game_id
            WHERE mp.market_type = 'game'
              AND mp.prop_type = 'runs'
              AND mp.card_decision = 'APPROVE'
              AND DATE(mp.created_at) = %s
        """
        params = [date]
        if confidence:
            q += " AND mp.confidence = %s"
            params.append(confidence)
        q += " ORDER BY GREATEST(COALESCE(mp.edge_home,0), COALESCE(mp.edge_away,0), COALESCE(mp.edge_over,0), COALESCE(mp.edge_under,0)) DESC"
        cur.execute(q, params)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [render_game_card(dict(r)) for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"games error: {e}")
        return []


@app.get("/model-record/mlb")
def get_model_record():
    try:
        import psycopg2.extras
        conn = get_conn()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT market_type, last_n_days, brier_score, mae, roi,
                   sample_size, drift_alert, computed_at
            FROM model_calibration
            ORDER BY computed_at DESC LIMIT 20
        """)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return list(rows)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"model-record error: {e}")
        return []
