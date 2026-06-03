"""
mlb/api/dashboard.py
────────────────────
FastAPI router: GET /api/mlb/dashboard

Returns today's ranked bet-value cards, sortable by:
  edge | line | k_rate | park_factor | dk_odds | fd_odds

Mount in your main app:
    from mlb.api.dashboard import router as mlb_dashboard
    app.include_router(mlb_dashboard)
"""

from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL
import logging

log    = logging.getLogger("betintel.api.dashboard")
router = APIRouter(prefix="/api/mlb", tags=["MLB Dashboard"])


# ── response schema ─────────────────────────────────────────────────────────────

class BetCard(BaseModel):
    rank:          int
    bet_label:     str
    game_id:       str
    player_name:   Optional[str]
    market_type:   str
    prop_type:     str
    direction:     str                 # OVER | UNDER | HOME | AWAY
    line:          Optional[float]
    dk_odds:       Optional[int]
    fd_odds:       Optional[int]
    model_prob:    Optional[float]     # 0-1
    market_impl:   Optional[float]     # 0-1
    edge:          float               # +/- fraction
    staking_pct:   Optional[float]
    # pitcher enrichment
    k_rate:        Optional[float]
    bb_rate:       Optional[float]
    opp_k_rate:    Optional[float]
    ip_per_start:  Optional[float]
    # park factor
    park_factor:   Optional[float]
    # confidence
    confidence:    Optional[str]       # HIGH | MEDIUM | LOW


class DashboardResponse(BaseModel):
    as_of:     str
    bet_count: int
    top5:      List[BetCard]
    all_bets:  List[BetCard]


# ── db helper ───────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DATABASE_URL)


# ── valid sort columns (whitelist — never interpolate user input directly) ───────

SORT_MAP = {
    "edge":        "best_edge DESC",
    "line":        "mp.line ASC",
    "k_rate":      "pkf.p_k_rate DESC",
    "park_factor": "grd_home.park_runs_factor DESC",
    "dk_odds":     "dk_snap.over_odds ASC",
    "fd_odds":     "fd_snap.over_odds ASC",
    "staking":     "mp.staking_pct DESC",
}


# ── core query (same logic as run_dashboard.py but returns all columns cleanly) ──

BASE_SQL = """
SELECT
    mp.id,
    mp.game_id,
    mp.player_name,
    mp.market_type,
    mp.prop_type,
    mp.model_mean,
    mp.line,
    mp.over_odds,
    mp.under_odds,
    mp.p_over,
    mp.p_under,
    mp.p_home,
    mp.p_away,
    mp.edge_over,
    mp.edge_under,
    mp.edge_home,
    mp.edge_away,
    mp.card_decision,
    mp.staking_pct,
    GREATEST(
        COALESCE(mp.edge_over,  -999),
        COALESCE(mp.edge_under, -999),
        COALESCE(mp.edge_home,  -999),
        COALESCE(mp.edge_away,  -999)
    ) AS best_edge,
    pkf.p_k_rate,
    pkf.p_bb_rate,
    pkf.opp_k_rate_vs_hand,
    pkf.p_ip_per_start,
    grd_home.park_runs_factor AS park_factor,
    dk_snap.over_odds  AS dk_over,
    dk_snap.under_odds AS dk_under,
    fd_snap.over_odds  AS fd_over,
    fd_snap.under_odds AS fd_under
FROM model_predictions mp
LEFT JOIN LATERAL (
    SELECT p_k_rate, p_bb_rate, opp_k_rate_vs_hand, p_ip_per_start
    FROM pitcher_k_games
    WHERE pitcher_id = mp.player_id AND DATE(date) = CURRENT_DATE
    LIMIT 1
) pkf ON mp.market_type = 'player_prop'
LEFT JOIN LATERAL (
    SELECT park_runs_factor
    FROM game_run_data
    WHERE game_id = mp.game_id AND is_home = 1
    LIMIT 1
) grd_home ON mp.market_type = 'game'
LEFT JOIN LATERAL (
    SELECT over_odds, under_odds FROM market_snapshots
    WHERE game_id = mp.game_id AND player_name = mp.player_name
      AND prop_type = mp.prop_type AND bookmaker = 'draftkings'
    ORDER BY snapshot_time DESC LIMIT 1
) dk_snap ON mp.market_type = 'player_prop'
LEFT JOIN LATERAL (
    SELECT over_odds, under_odds FROM market_snapshots
    WHERE game_id = mp.game_id AND player_name = mp.player_name
      AND prop_type = mp.prop_type AND bookmaker = 'fanduel'
    ORDER BY snapshot_time DESC LIMIT 1
) fd_snap ON mp.market_type = 'player_prop'
WHERE DATE(mp.created_at) = CURRENT_DATE
  AND mp.card_decision = 'CANDIDATE'
  AND GREATEST(
        COALESCE(mp.edge_over,  -999),
        COALESCE(mp.edge_under, -999),
        COALESCE(mp.edge_home,  -999),
        COALESCE(mp.edge_away,  -999)
      ) >= 0
"""


def _best_direction(row: dict) -> tuple:
    candidates = [
        (row.get("edge_over")  or -999, "OVER",  row.get("p_over"),  row.get("dk_over"),  row.get("fd_over")),
        (row.get("edge_under") or -999, "UNDER", row.get("p_under"), row.get("dk_under"), row.get("fd_under")),
        (row.get("edge_home")  or -999, "HOME",  row.get("p_home"),  None,                None),
        (row.get("edge_away")  or -999, "AWAY",  row.get("p_away"),  None,                None),
    ]
    return max(candidates, key=lambda x: x[0])


def _confidence(edge: float) -> str:
    if edge >= 0.06:
        return "HIGH"
    if edge >= 0.04:
        return "MEDIUM"
    return "LOW"


def _row_to_card(rank: int, row: dict) -> BetCard:
    edge_val, direction, model_p, dk_o, fd_o = _best_direction(row)
    name   = row.get("player_name") or f"Game {row['game_id'][-6:]}"
    ptype  = row.get("prop_type", "")
    label  = f"{name} {ptype.upper()} {direction}"
    if row.get("line"):
        label += f" {row['line']}"
    return BetCard(
        rank         = rank,
        bet_label    = label,
        game_id      = row["game_id"],
        player_name  = row.get("player_name"),
        market_type  = row["market_type"],
        prop_type    = row["prop_type"],
        direction    = direction,
        line         = row.get("line"),
        dk_odds      = dk_o,
        fd_odds      = fd_o,
        model_prob   = round(model_p, 4) if model_p else None,
        market_impl  = round(model_p - edge_val, 4) if model_p and edge_val else None,
        edge         = round(edge_val, 4),
        staking_pct  = row.get("staking_pct"),
        k_rate       = row.get("p_k_rate"),
        bb_rate      = row.get("p_bb_rate"),
        opp_k_rate   = row.get("opp_k_rate_vs_hand"),
        ip_per_start = row.get("p_ip_per_start"),
        park_factor  = row.get("park_factor"),
        confidence   = _confidence(edge_val),
    )


# ── route ────────────────────────────────────────────────────────────────────────

@router.get("/dashboard", response_model=DashboardResponse, summary="MLB bet-value dashboard")
def get_dashboard(
    sort_by: str  = Query(default="edge",  description=f"Sort column: {', '.join(SORT_MAP)}"),
    top_n:   int  = Query(default=5,       ge=1, le=20, description="Number of top bets to highlight"),
    min_edge: float = Query(default=0.03,  ge=0.0, le=1.0, description="Minimum edge filter (fraction)"),
):
    if sort_by not in SORT_MAP:
        raise HTTPException(status_code=400, detail=f"sort_by must be one of: {', '.join(SORT_MAP)}")

    order_clause = SORT_MAP[sort_by]
    sql = BASE_SQL + f"  AND GREATEST(COALESCE(mp.edge_over,-999),COALESCE(mp.edge_under,-999),COALESCE(mp.edge_home,-999),COALESCE(mp.edge_away,-999)) >= %(min_edge)s\nORDER BY {order_clause}\nLIMIT 50"

    try:
        conn = get_db()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, {"min_edge": min_edge})
        rows = [dict(r) for r in cur.fetchall()]
        cur.close()
        conn.close()
    except Exception as e:
        log.error(f"dashboard query failed: {e}")
        raise HTTPException(status_code=500, detail="Database query failed")

    from datetime import datetime
    from zoneinfo import ZoneInfo
    cards    = [_row_to_card(i+1, r) for i, r in enumerate(rows)]
    top_cards = cards[:top_n]

    return DashboardResponse(
        as_of      = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d %H:%M ET"),
        bet_count  = len(cards),
        top5       = top_cards,
        all_bets   = cards,
    )
