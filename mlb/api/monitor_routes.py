"""
BetIntel Monitor API Routes
============================
Mount onto the existing FastAPI app in mlb/api/main.py:

    from mlb.api.monitor_routes import router as monitor_router
    app.include_router(monitor_router, prefix="/monitor")

Endpoints:
  GET /monitor/alerts/active          – live alerts for dashboard banner
  GET /monitor/alerts/log             – full rolling log with pagination
  GET /monitor/alerts/{alert_id}      – single alert detail
  POST /monitor/alerts/{alert_id}/resolve  – manual resolve
"""

from fastapi import APIRouter, Query, HTTPException
from typing import Optional
import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL
from datetime import datetime

router = APIRouter(tags=["monitor"])


def _conn():
    return psycopg2.connect(DATABASE_URL)


@router.get("/alerts/active")
def get_active_alerts(
    market_type: Optional[str] = Query(default=None,
        description="Filter: 'game_total' | 'moneyline' | 'k_prop'"),
    min_edge: float = Query(default=0.05,
        description="Minimum edge % to return (0.05 = 5%)"),
):
    """
    Returns all ACTIVE edge alerts for the dashboard notification banner.
    Ordered by edge_pct descending (highest edge first).
    Excludes alerts for games that have already started (expires_at < NOW).
    """
    conn = _conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    q = """
        SELECT
            ea.*,
            gc.game_date,
            gc.venue_name,
            COALESCE(gm.home_team, '') || ' vs ' || COALESCE(gm.away_team, '') AS matchup
        FROM edge_alerts ea
        JOIN game_context gc  ON ea.game_id = gc.game_id
        LEFT JOIN game_id_map gm ON ea.game_id = gm.mlb_game_pk
        WHERE ea.alert_status = 'ACTIVE'
          AND ea.edge_pct >= %s
          AND (ea.expires_at IS NULL OR ea.expires_at > NOW())
    """
    params = [min_edge]
    if market_type:
        q += " AND ea.market_type = %s"
        params.append(market_type)
    q += " ORDER BY ea.edge_pct DESC"

    cur.execute(q, params)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    return {
        "as_of": datetime.utcnow().isoformat() + "Z",
        "active_count": len(rows),
        "alerts": [
            {
                "id":               r["id"],
                "matchup":          r["matchup"],
                "game_id":          r["game_id"],
                "market_type":      r["market_type"],
                "prop_side":        r["prop_side"],
                "player_name":      r["player_name"],
                "model_prob_pct":   round(r["model_prob"] * 100, 1),
                "market_implied_pct": round(r["market_implied"] * 100, 1),
                "edge_pct":         round(r["edge_pct"] * 100, 1),
                "market_line":      r["market_line"],
                "market_odds_dk":   r["market_odds_dk"],
                "market_odds_fd":   r["market_odds_fd"],
                "model_mean":       r["model_mean"],
                "lineup_confirmed": r["lineup_confirmed"],
                "sp_confirmed":     r["sp_confirmed"],
                "injury_flag":      r["injury_flag"],
                "injury_note":      r["injury_note"],
                "triggered_at":     r["triggered_at"].isoformat() if r["triggered_at"] else None,
                "expires_at":       r["expires_at"].isoformat() if r["expires_at"] else None,
                "game_date":        r["game_date"].isoformat() if r["game_date"] else None,
            }
            for r in rows
        ]
    }


@router.get("/alerts/log")
def get_alert_log(
    date: Optional[str]  = Query(default=None, description="YYYY-MM-DD, defaults to today"),
    status: Optional[str] = Query(default=None, description="ACTIVE | EXPIRED | RESOLVED"),
    market_type: Optional[str] = Query(default=None),
    limit: int  = Query(default=50,  ge=1, le=500),
    offset: int = Query(default=0,   ge=0),
):
    """
    Full paginated rolling log of every triggered alert.
    Includes sportsbook odds at trigger time and model projection.
    """
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    conn = _conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    q = """
        SELECT
            ea.*,
            COALESCE(gm.home_team, '') || ' vs ' || COALESCE(gm.away_team, '') AS matchup
        FROM edge_alerts ea
        LEFT JOIN game_id_map gm ON ea.game_id = gm.mlb_game_pk
        WHERE DATE(ea.triggered_at) = %s
    """
    params = [date]
    if status:
        q += " AND ea.alert_status = %s"
        params.append(status)
    if market_type:
        q += " AND ea.market_type = %s"
        params.append(market_type)
    q += " ORDER BY ea.triggered_at DESC LIMIT %s OFFSET %s"
    params += [limit, offset]

    cur.execute(q, params)
    rows = cur.fetchall()

    # Total count for pagination
    count_q = "SELECT COUNT(*) FROM edge_alerts WHERE DATE(triggered_at) = %s"
    count_params = [date]
    if status:
        count_q += " AND alert_status = %s"
        count_params.append(status)
    cur.execute(count_q, count_params)
    total = cur.fetchone()["count"]

    cur.close()
    conn.close()

    return {
        "date":    date,
        "total":   total,
        "limit":   limit,
        "offset":  offset,
        "log": [
            {
                "id":                r["id"],
                "triggered_at":      r["triggered_at"].isoformat() if r["triggered_at"] else None,
                "resolved_at":       r["resolved_at"].isoformat() if r["resolved_at"] else None,
                "status":            r["alert_status"],
                "matchup":           r["matchup"],
                "game_id":           r["game_id"],
                "market_type":       r["market_type"],
                "prop_side":         r["prop_side"],
                "player_name":       r["player_name"],
                "edge_pct":          round(r["edge_pct"] * 100, 1),
                "model_prob_pct":    round(r["model_prob"] * 100, 1),
                "market_implied_pct": round(r["market_implied"] * 100, 1),
                "model_mean":        r["model_mean"],
                "market_line":       r["market_line"],
                "market_odds_dk":    r["market_odds_dk"],
                "market_odds_fd":    r["market_odds_fd"],
                "lineup_confirmed":  r["lineup_confirmed"],
                "sp_confirmed":      r["sp_confirmed"],
                "injury_flag":       r["injury_flag"],
                "injury_note":       r["injury_note"],
                "resolution_note":   r["resolution_note"],
            }
            for r in rows
        ]
    }


@router.get("/alerts/{alert_id}")
def get_alert_detail(alert_id: int):
    conn = _conn()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM edge_alerts WHERE id = %s", (alert_id,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Alert not found")
    return dict(row)


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: int, note: Optional[str] = Query(default=None)):
    conn = _conn()
    cur = conn.cursor()
    cur.execute("""
        UPDATE edge_alerts
        SET alert_status    = 'RESOLVED',
            resolved_at     = NOW(),
            resolution_note = %s
        WHERE id = %s AND alert_status = 'ACTIVE'
        RETURNING id
    """, (note or "Manually resolved", alert_id))
    updated = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()
    if not updated:
        raise HTTPException(status_code=404, detail="Alert not found or already resolved")
    return {"resolved": True, "alert_id": alert_id}
