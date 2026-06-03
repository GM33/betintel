"""
mlb/run_dashboard.py
────────────────────
End-to-end MLB bet-value dashboard pipeline.
Run:  python -m mlb.run_dashboard

Step order:
  1. fetch_odds          — game moneylines, runlines, totals  → market_snapshots
  2. fetch_player_props  — pitcher K props (DK + FD)          → market_snapshots
  3. predict_k           — ML K-mean per pitcher              → model_predictions
  4. predict_runs        — ML run-mean per team               → model_predictions
  5. compute_k_edges     — Poisson edge vs market implied      → model_predictions (update)
  6. compute_run_edges   — Poisson edge vs market implied      → model_predictions (update)
  7. print_dashboard     — ranked top-5 table to stdout
"""

import logging
import sys
import psycopg2
import psycopg2.extras
from datetime import datetime
from zoneinfo import ZoneInfo

from mlb.ingestion.odds   import fetch_odds
from mlb.ingestion.props  import fetch_player_props
from mlb.models.predict_k    import predict_k_for_today
from mlb.models.predict_runs import predict_runs_for_today
from mlb.models.compute_edges import compute_k_edges, compute_run_edges
from mlb.config import DATABASE_URL

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("betintel.run_dashboard")
ET  = ZoneInfo("America/New_York")


# ── helpers ────────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DATABASE_URL)


def _fmt_odds(v):
    if v is None:
        return "n/a"
    return f"+{v}" if v > 0 else str(v)


def _fmt_pct(v):
    return f"{v*100:+.1f}%" if v is not None else "n/a"


# ── dashboard query ─────────────────────────────────────────────────────────────

DASHBOARD_SQL = """
SELECT
    mp.id,
    mp.game_id,
    mp.player_name,
    mp.market_type,
    mp.prop_type,
    mp.model_mean,
    mp.model_mean_home,
    mp.model_mean_away,
    mp.line,
    mp.over_odds,
    mp.under_odds,
    mp.p_over,
    mp.p_under,
    mp.edge_over,
    mp.edge_under,
    mp.edge_home,
    mp.edge_away,
    mp.card_decision,
    mp.staking_pct,
    -- best edge direction
    GREATEST(
        COALESCE(mp.edge_over,  -999),
        COALESCE(mp.edge_under, -999),
        COALESCE(mp.edge_home,  -999),
        COALESCE(mp.edge_away,  -999)
    ) AS best_edge,
    -- pitcher feature enrichment (K props only)
    pkf.p_k_rate,
    pkf.p_bb_rate,
    pkf.opp_k_rate_vs_hand,
    pkf.p_ip_per_start,
    -- park factor (run props only)
    grd_home.park_runs_factor AS park_factor,
    -- DraftKings vs FanDuel split (latest snapshot per book)
    dk_snap.over_odds   AS dk_over,
    dk_snap.under_odds  AS dk_under,
    fd_snap.over_odds   AS fd_over,
    fd_snap.under_odds  AS fd_under
FROM model_predictions mp

-- pitcher game features (K props)
LEFT JOIN LATERAL (
    SELECT p_k_rate, p_bb_rate, opp_k_rate_vs_hand, p_ip_per_start
    FROM pitcher_k_games
    WHERE pitcher_id = mp.player_id
      AND DATE(date) = CURRENT_DATE
    LIMIT 1
) pkf ON mp.market_type = 'player_prop'

-- park factor (game totals)
LEFT JOIN LATERAL (
    SELECT park_runs_factor
    FROM game_run_data
    WHERE game_id = mp.game_id AND is_home = 1
    LIMIT 1
) grd_home ON mp.market_type = 'game'

-- DraftKings latest prop snapshot
LEFT JOIN LATERAL (
    SELECT over_odds, under_odds
    FROM market_snapshots
    WHERE game_id    = mp.game_id
      AND player_name = mp.player_name
      AND prop_type   = mp.prop_type
      AND bookmaker   = 'draftkings'
    ORDER BY snapshot_time DESC
    LIMIT 1
) dk_snap ON mp.market_type = 'player_prop'

-- FanDuel latest prop snapshot
LEFT JOIN LATERAL (
    SELECT over_odds, under_odds
    FROM market_snapshots
    WHERE game_id    = mp.game_id
      AND player_name = mp.player_name
      AND prop_type   = mp.prop_type
      AND bookmaker   = 'fanduel'
    ORDER BY snapshot_time DESC
    LIMIT 1
) fd_snap ON mp.market_type = 'player_prop'

WHERE DATE(mp.created_at) = CURRENT_DATE
  AND mp.card_decision = 'CANDIDATE'
  AND GREATEST(
        COALESCE(mp.edge_over,  -999),
        COALESCE(mp.edge_under, -999),
        COALESCE(mp.edge_home,  -999),
        COALESCE(mp.edge_away,  -999)
      ) >= 0
ORDER BY best_edge DESC
LIMIT 20
"""


def fetch_dashboard_rows():
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(DASHBOARD_SQL)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [dict(r) for r in rows]


# ── stdout table printer ────────────────────────────────────────────────────────

def print_dashboard(rows):
    if not rows:
        print("\n⚠  No CANDIDATE bets for today.")
        return

    # ── top 5 by edge
    top5 = rows[:5]
    medals = ["🥇", "🥈", "🥉", " 4 ", " 5 "]

    print("\n" + "═" * 90)
    print(f"  BetIntel MLB Bet-Value Dashboard — {datetime.now(ET).strftime('%b %d, %Y  %I:%M %p ET')}")
    print("═" * 90)
    print(f"{'#':<4} {'Bet':<36} {'Line':>6} {'DK':>6} {'FD':>6} {'Mkt%':>7} {'Model%':>8} {'Edge':>7} {'Stake':>7}")
    print("─" * 90)

    for i, row in enumerate(top5):
        medal   = medals[i]
        name    = row.get("player_name") or f"Game {row['game_id'][-6:]}"
        ptype   = row.get("prop_type", "")
        line    = row.get("line")
        edge    = row.get("best_edge", 0)
        stake   = row.get("staking_pct") or 0

        # which direction is the edge?
        e_over  = row.get("edge_over")  or -999
        e_under = row.get("edge_under") or -999
        e_home  = row.get("edge_home")  or -999
        e_away  = row.get("edge_away")  or -999
        best_dir = max([(e_over, "OVER"), (e_under, "UNDER"),
                        (e_home, "HOME"), (e_away, "AWAY")], key=lambda x: x[0])
        direction = best_dir[1]

        # odds for best direction
        if direction == "OVER":
            dk_o = _fmt_odds(row.get("dk_over"))
            fd_o = _fmt_odds(row.get("fd_over"))
            mkt_imp = row.get("p_over") or 0
            model_p = row.get("p_over") or 0
        elif direction == "UNDER":
            dk_o = _fmt_odds(row.get("dk_under"))
            fd_o = _fmt_odds(row.get("fd_under"))
            mkt_imp = row.get("p_under") or 0
            model_p = row.get("p_under") or 0
        else:
            dk_o = fd_o = "n/a"
            mkt_imp = 0
            model_p = row.get("p_home") if direction == "HOME" else row.get("p_away") or 0

        bet_label = f"{name} {ptype.upper()} {direction} {line or ''}"
        print(f"{medal:<4} {bet_label:<36} {str(line or ''):>6} {dk_o:>6} {fd_o:>6} "
              f"{mkt_imp*100:>6.1f}% {model_p*100:>7.1f}% {edge*100:>+6.1f}% "
              f"{stake*100:>6.1f}%")

    print("─" * 90)

    # ── full ranked table (all CANDIDATE bets)
    print(f"\n  Full Rankings ({len(rows)} CANDIDATE bets today)")
    print("─" * 110)
    header = (f"{'#':<4} {'Pitcher/Game':<28} {'Type':<14} {'Line':>5} {'DK':>6} {'FD':>6} "
              f"{'K-Rate':>7} {'BB%':>6} {'OppK%':>6} {'ParkF':>6} {'Edge':>7} {'Decision':<12}")
    print(header)
    print("─" * 110)
    for i, row in enumerate(rows, 1):
        name   = (row.get("player_name") or f"Game {row['game_id'][-6:]}")[:27]
        ptype  = row.get("prop_type", "")[:13]
        line   = row.get("line") or ""
        dk_o   = _fmt_odds(row.get("dk_over") or row.get("over_odds"))
        fd_o   = _fmt_odds(row.get("fd_over") or row.get("over_odds"))
        krate  = f"{row['p_k_rate']*100:.1f}%"   if row.get("p_k_rate")   else "—"
        bbrate = f"{row['p_bb_rate']*100:.1f}%"  if row.get("p_bb_rate")  else "—"
        oppk   = f"{row['opp_k_rate_vs_hand']*100:.1f}%" if row.get("opp_k_rate_vs_hand") else "—"
        parkf  = f"{row['park_factor']:.2f}"      if row.get("park_factor") else "—"
        edge   = row.get("best_edge", 0)
        dec    = row.get("card_decision", "")
        print(f"{i:<4} {name:<28} {ptype:<14} {str(line):>5} {dk_o:>6} {fd_o:>6} "
              f"{krate:>7} {bbrate:>6} {oppk:>6} {parkf:>6} {edge*100:>+6.1f}% {dec:<12}")

    print("═" * 110 + "\n")


# ── main orchestrator ───────────────────────────────────────────────────────────

def run():
    log.info("── Step 1/6: Fetching game odds (h2h, spreads, totals)")
    try:
        fetch_odds(snapshot_type="pre_game")
    except Exception as e:
        log.error(f"fetch_odds failed: {e}")

    log.info("── Step 2/6: Fetching pitcher K props")
    try:
        fetch_player_props()
    except Exception as e:
        log.error(f"fetch_player_props failed: {e}")

    log.info("── Step 3/6: Generating K predictions")
    try:
        predict_k_for_today()
    except Exception as e:
        log.error(f"predict_k_for_today failed: {e}")

    log.info("── Step 4/6: Generating run predictions")
    try:
        predict_runs_for_today()
    except Exception as e:
        log.error(f"predict_runs_for_today failed: {e}")

    log.info("── Step 5/6: Computing K prop edges")
    try:
        compute_k_edges()
    except Exception as e:
        log.error(f"compute_k_edges failed: {e}")

    log.info("── Step 6/6: Computing run total edges")
    try:
        compute_run_edges()
    except Exception as e:
        log.error(f"compute_run_edges failed: {e}")

    log.info("── Fetching dashboard rows")
    rows = fetch_dashboard_rows()
    print_dashboard(rows)
    return rows


if __name__ == "__main__":
    run()
