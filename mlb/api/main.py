from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL
from mlb.cards.k_card import render_k_card
from mlb.cards.game_card import render_game_card
from datetime import datetime

app = FastAPI(title="BetIntel MLB API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_conn():
    return psycopg2.connect(DATABASE_URL)

@app.get("/health")
def health():
    return {"status": "ok", "service": "betintel-mlb", "ts": datetime.utcnow().isoformat()}

@app.get("/cards/mlb/k-props")
def get_k_prop_cards(
    date: Optional[str] = Query(default=None),
    confidence: Optional[str] = Query(default=None)
):
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
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

@app.get("/cards/mlb/games")
def get_game_cards(
    date: Optional[str] = Query(default=None),
    confidence: Optional[str] = Query(default=None)
):
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
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

@app.get("/model-record/mlb")
def get_model_record():
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
