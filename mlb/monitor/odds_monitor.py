"""
BetIntel MLB Real-Time Odds Monitor
====================================
Polls live market odds every N minutes, compares against current model
predictions, and writes an alert row to edge_alerts whenever:

    |model_prob - market_implied_prob| >= EDGE_THRESHOLD (default 0.05 / 5%)

Designed to run as a background thread inside the FastAPI process OR
as a standalone APScheduler job in runner.py.

Triggers re-model when:
  - lineup_confirmed flips True
  - sp_confirmed flips True
  - Any player in the lineup has a new injury flag (stubbed; extend via
    your injury ingestion module when ready)
"""

import logging
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone
from typing import Optional

from mlb.config import DATABASE_URL
from mlb.ingestion.odds import fetch_odds          # existing ingestion job
from mlb.ingestion.lineups import fetch_lineups    # existing ingestion job
from mlb.models.predict_k import predict_k_for_today
from mlb.models.predict_runs import predict_runs_for_today
from mlb.models.compute_edges import compute_k_edges, compute_run_edges
from mlb.analyst.analyst_agent import run_analyst_agent_for_today

log = logging.getLogger("betintel.monitor")

# ── CONFIG ───────────────────────────────────────────────────────────────────
EDGE_THRESHOLD      = 0.05   # 5% deviation triggers alert
POLL_INTERVAL_MIN   = 5      # how often odds_monitor runs (set in runner.py)
MIN_REFIRE_MINUTES  = 30     # suppress duplicate alerts for same game/market


# ── HELPERS ──────────────────────────────────────────────────────────────────

def _get_conn():
    return psycopg2.connect(DATABASE_URL)


def _american_to_implied(odds: int) -> Optional[float]:
    """Convert American odds integer to implied probability (0-1)."""
    if odds is None:
        return None
    if odds > 0:
        return round(100 / (odds + 100), 6)
    return round(-odds / (-odds + 100), 6)


def _best_implied(over_odds: Optional[int], home_odds: Optional[int]) -> Optional[float]:
    """Return the lower (sharper) implied probability from two books."""
    candidates = [v for v in [over_odds, home_odds] if v is not None]
    if not candidates:
        return None
    # lower implied = better value for bettor
    return min(_american_to_implied(o) for o in candidates)


def _already_alerted(cur, game_id: str, market_type: str,
                     prop_side: str, player_id: Optional[int]) -> bool:
    """True if an ACTIVE alert for this exact market was fired < MIN_REFIRE_MINUTES ago."""
    cur.execute("""
        SELECT 1 FROM edge_alerts
        WHERE game_id      = %s
          AND market_type  = %s
          AND prop_side    = %s
          AND (player_id   = %s OR (%s IS NULL AND player_id IS NULL))
          AND alert_status = 'ACTIVE'
          AND triggered_at > NOW() - INTERVAL '%s minutes'
        LIMIT 1
    """, (game_id, market_type, prop_side,
          player_id, player_id,
          MIN_REFIRE_MINUTES))
    return cur.fetchone() is not None


def _expire_stale_alerts(cur):
    """Mark alerts as EXPIRED once the game start time has passed."""
    cur.execute("""
        UPDATE edge_alerts
        SET alert_status = 'EXPIRED',
            resolved_at  = NOW(),
            resolution_note = 'Game started'
        WHERE alert_status = 'ACTIVE'
          AND expires_at  IS NOT NULL
          AND expires_at  < NOW()
    """)


def _close_resolved_alerts(cur):
    """
    Mark an ACTIVE alert RESOLVED when the edge has closed
    (current edge_over/under in model_predictions < threshold).
    Called after each odds refresh cycle.
    """
    cur.execute("""
        UPDATE edge_alerts ea
        SET alert_status    = 'RESOLVED',
            resolved_at     = NOW(),
            resolution_note = 'Edge closed below threshold after line move'
        FROM model_predictions mp
        WHERE ea.alert_status  = 'ACTIVE'
          AND ea.game_id       = mp.game_id
          AND ea.market_type   = mp.market_type
          AND (
              (ea.prop_side = 'over'  AND COALESCE(mp.edge_over,  0) < ea.edge_threshold)
           OR (ea.prop_side = 'under' AND COALESCE(mp.edge_under, 0) < ea.edge_threshold)
           OR (ea.prop_side = 'home'  AND COALESCE(mp.edge_home,  0) < ea.edge_threshold)
           OR (ea.prop_side = 'away'  AND COALESCE(mp.edge_away,  0) < ea.edge_threshold)
          )
    """)


# ── CONTEXT CHANGE DETECTOR ───────────────────────────────────────────────────

def _context_changed_since_last_run(conn) -> bool:
    """
    Returns True if any game_context row was updated in the last POLL_INTERVAL_MIN
    minutes — meaning lineups or SP confirmation flipped, warranting a re-model.
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT 1 FROM game_context
        WHERE last_updated > NOW() - INTERVAL '%s minutes'
        LIMIT 1
    """, (POLL_INTERVAL_MIN,))
    changed = cur.fetchone() is not None
    cur.close()
    return changed


# ── CORE MONITOR LOOP ─────────────────────────────────────────────────────────

def run_odds_monitor():
    """
    Main entry point.  Called by APScheduler every POLL_INTERVAL_MIN minutes.

    Flow:
      1. Refresh live odds into market_snapshots  (existing fetch_odds)
      2. If game_context changed → re-run lineup fetch + models + edges + analyst
      3. Compare model_predictions vs freshest market_snapshots
      4. Write edge_alerts for any edge >= EDGE_THRESHOLD not already alerted recently
      5. Expire stale alerts, resolve closed edges
    """
    log.info("[monitor] odds_monitor cycle start")
    conn = _get_conn()

    try:
        # Step 1 – refresh odds
        fetch_odds("live_poll")

        # Step 2 – re-model if context changed (lineup/SP flip or injury)
        if _context_changed_since_last_run(conn):
            log.info("[monitor] game_context changed – triggering re-model")
            fetch_lineups()
            predict_k_for_today()
            predict_runs_for_today()
            compute_k_edges()
            compute_run_edges()
            run_analyst_agent_for_today()

        # Step 3 – compare model vs market
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("""
            SELECT
                mp.id,
                mp.game_id,
                mp.player_id,
                mp.player_name,
                mp.market_type,
                mp.prop_type,
                mp.model_mean,
                mp.model_mean_home,
                mp.model_mean_away,
                mp.p_over,   mp.p_under,
                mp.p_home,   mp.p_away,
                mp.edge_over, mp.edge_under,
                mp.edge_home, mp.edge_away,
                mp.line,
                mp.over_odds,  mp.under_odds,
                mp.home_odds,  mp.away_odds,
                gc.lineup_confirmed,
                gc.sp_confirmed,
                gc.game_date
            FROM model_predictions mp
            JOIN game_context gc ON mp.game_id = gc.game_id
            WHERE DATE(mp.created_at) = CURRENT_DATE
              AND mp.card_decision IN ('APPROVE', 'CANDIDATE')
        """)
        rows = cur.fetchall()

        alert_cur = conn.cursor()
        _expire_stale_alerts(alert_cur)
        _close_resolved_alerts(alert_cur)

        alerts_fired = 0
        for row in rows:
            _check_and_fire_alerts(row, alert_cur)
            alerts_fired += 1  # counts checks, not fires

        conn.commit()
        alert_cur.close()
        cur.close()
        log.info(f"[monitor] cycle complete – {alerts_fired} predictions checked")

    except Exception as e:
        log.error(f"[monitor] cycle error: {e}")
        conn.rollback()
    finally:
        conn.close()


def _check_and_fire_alerts(row: dict, alert_cur) -> None:
    """
    For a single model_prediction row, check each side for a >=5% edge
    and write an alert if not already suppressed.
    """
    sides = [
        ("over",  row.get("p_over"),  row.get("over_odds"),  row.get("edge_over")),
        ("under", row.get("p_under"), row.get("under_odds"), row.get("edge_under")),
        ("home",  row.get("p_home"),  row.get("home_odds"),  row.get("edge_home")),
        ("away",  row.get("p_away"),  row.get("away_odds"),  row.get("edge_away")),
    ]

    for side, model_prob, best_odds, edge in sides:
        if model_prob is None or edge is None:
            continue
        if abs(edge) < EDGE_THRESHOLD:
            continue

        market_implied = _american_to_implied(best_odds)
        if market_implied is None:
            continue

        # Suppress re-fire
        if _already_alerted(alert_cur,
                            row["game_id"], row["market_type"],
                            side, row.get("player_id")):
            continue

        # Determine model_line and model_mean based on side
        model_mean = row.get("model_mean")
        if side == "home":
            model_mean = row.get("model_mean_home")
        elif side == "away":
            model_mean = row.get("model_mean_away")

        alert_cur.execute("""
            INSERT INTO edge_alerts (
                game_id, player_id, player_name,
                market_type, prop_side,
                model_prob, model_mean, model_line,
                market_line, market_odds_dk, market_odds_fd, market_implied,
                edge_pct, edge_threshold,
                lineup_confirmed, sp_confirmed,
                alert_status, triggered_at, expires_at
            ) VALUES (
                %s, %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s,
                %s, %s,
                'ACTIVE', NOW(), %s
            )
        """, (
            row["game_id"], row.get("player_id"), row.get("player_name"),
            row["market_type"], side,
            round(model_prob, 4), model_mean, row.get("line"),
            row.get("line"), best_odds, best_odds, round(market_implied, 4),
            round(edge, 4), EDGE_THRESHOLD,
            row.get("lineup_confirmed"), row.get("sp_confirmed"),
            row.get("game_date"),
        ))
        log.info(
            f"[monitor] ALERT FIRED | {row['game_id']} | "
            f"{row['market_type']} {side} | edge={round(edge*100,1)}% | "
            f"model={round(model_prob*100,1)}% vs implied={round(market_implied*100,1)}%"
        )
