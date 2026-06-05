import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import poisson
from mlb.config import DATABASE_URL, EDGE_THRESHOLD, KELLY_FRACTION, MAX_STAKE_PCT
from datetime import datetime
import logging

log = logging.getLogger("betintel.models.compute_edges")

# ── Bullpen fatigue thresholds (June 3 upgrade) ───────────────────────────────
BP_CRITICAL_IP   = 18.0
BP_ELEVATED_IP   = 15.0
BP_CRITICAL_MULT = 1.12
BP_ELEVATED_MULT = 1.06

# ── June 5 recalibration: confidence floor & favorite cliff ──────────────────
CONFIDENCE_FLOOR       = 0.60   # picks below this are suppressed from card output
FAVORITE_CLIFF_ODDS    = -180   # chalk plays beyond this REQUIRE a secondary signal
MOMENTUM_WEIGHT        = 0.12   # weight applied to last-5 run-diff delta on model_mean

def get_db():
    return psycopg2.connect(DATABASE_URL)

def implied_prob_american(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)

def kelly_stake(p_model, odds_american):
    if odds_american is None or p_model is None:
        return None
    b = (odds_american / 100) if odds_american > 0 else (100 / -odds_american)
    q = 1 - p_model
    f = (b * p_model - q) / b
    return round(min(max(f * KELLY_FRACTION, 0), MAX_STAKE_PCT), 4)

def _fetch_bp_fatigue(cur, team_id, date_str):
    """Returns bp_ip_last_3d for a team on a given date, or 0.0 if not found."""
    cur.execute("""
        SELECT bp_ip_last_3d FROM bullpen_stats
        WHERE team_id=%s AND date=%s
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] else 0.0

def _fetch_momentum_delta(cur, team_id, date_str):
    """
    Returns the last-5-game run differential for a team.
    Positive = team outscoring opponents; negative = being outscored.
    Used to apply MOMENTUM_WEIGHT adjustment to model_mean.
    """
    cur.execute("""
        SELECT AVG(run_diff_last5) FROM team_momentum
        WHERE team_id=%s AND date<=%s
        ORDER BY date DESC LIMIT 1
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0

def _is_trap_game(cur, game_id):
    """
    Returns True if the game has been flagged as a trap in game_context.
    Trap-flagged games are SUPPRESSED from card output entirely (June 5 rule).
    """
    cur.execute("""
        SELECT is_trap FROM game_context WHERE game_id=%s
    """, (game_id,))
    row = cur.fetchone()
    return bool(row[0]) if row and row[0] is not None else False

def _has_secondary_signal(cur, game_id, side):
    """
    For chalk favorites beyond FAVORITE_CLIFF_ODDS, verifies at least one
    secondary sharp signal exists: line movement, sharp money %, or SP FIP edge.
    Returns True if a qualifying signal is found.
    """
    cur.execute("""
        SELECT line_moved_sharp, sharp_money_pct, sp_fip_edge
        FROM sharp_signals
        WHERE game_id=%s AND side=%s
        ORDER BY created_at DESC LIMIT 1
    """, (game_id, side))
    row = cur.fetchone()
    if not row:
        return False
    line_moved_sharp, sharp_money_pct, sp_fip_edge = row
    return bool(line_moved_sharp) or (sharp_money_pct and sharp_money_pct >= 60) or (sp_fip_edge and sp_fip_edge >= 0.03)

def compute_k_edges():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT mp.id, mp.game_id, mp.player_id, mp.model_mean,
               ms.line, ms.over_odds, ms.under_odds, ms.player_name
        FROM model_predictions mp
        JOIN market_snapshots ms
          ON mp.game_id = ms.game_id
         AND mp.player_id = ms.player_id
         AND ms.market_type = 'player_prop'
         AND ms.prop_type = 'k_strikeouts'
        WHERE mp.market_type = 'player_prop'
          AND mp.p_over IS NULL
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()

    for row in rows:
        lam = row["model_mean"]
        line = row["line"]
        if not lam or not line:
            continue
        p_over = float(1 - poisson.cdf(int(line), lam))
        p_under = float(poisson.cdf(int(line), lam))
        p_imp_over = implied_prob_american(row["over_odds"])
        p_imp_under = implied_prob_american(row["under_odds"])
        edge_over = round(p_over - p_imp_over, 4) if p_imp_over else None
        edge_under = round(p_under - p_imp_under, 4) if p_imp_under else None
        edges = [e for e in [edge_over, edge_under] if e is not None]
        best_edge = max(edges) if edges else None

        # ── Confidence floor filter (June 5) ─────────────────────────────────
        best_conf = max(p_over, p_under) if p_over and p_under else None
        below_floor = best_conf is not None and best_conf < CONFIDENCE_FLOOR

        if below_floor:
            decision = "LEAN"   # shown in UI with 0.5u max tag, not as a full pick
        else:
            decision = "CANDIDATE" if best_edge and best_edge >= EDGE_THRESHOLD else "NO BET"

        staking = None
        if decision == "CANDIDATE":
            if edge_over and edge_over == best_edge:
                staking = kelly_stake(p_over, row["over_odds"])
            else:
                staking = kelly_stake(p_under, row["under_odds"])
        elif decision == "LEAN":
            staking = 0.005   # 0.5% bankroll max for LEAN tier

        update_cur.execute("""
            UPDATE model_predictions SET
                player_name=%s, line=%s, over_odds=%s, under_odds=%s,
                p_over=%s, p_under=%s, edge_over=%s, edge_under=%s,
                card_decision=%s, staking_pct=%s
            WHERE id=%s
        """, (
            row["player_name"], line, row["over_odds"], row["under_odds"],
            p_over, p_under, edge_over, edge_under,
            decision, staking, row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_k_edges: processed {len(rows)} rows")

def compute_run_edges(gamma: float = 1.86):
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    today = datetime.utcnow().strftime("%Y-%m-%d")

    cur.execute("""
        SELECT mp.id, mp.game_id, mp.model_mean_home, mp.model_mean_away,
               gc.home_team_id, gc.away_team_id,
               gc.is_trap,
               ms_ml.home_odds, ms_ml.away_odds,
               ms_tot.line AS total_line,
               ms_tot.over_odds AS total_over_odds,
               ms_tot.under_odds AS total_under_odds
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        LEFT JOIN LATERAL (
            SELECT home_odds, away_odds FROM market_snapshots
            WHERE game_id = mp.game_id AND market_type = 'h2h'
            ORDER BY snapshot_time DESC LIMIT 1
        ) ms_ml ON TRUE
        LEFT JOIN LATERAL (
            SELECT line, over_odds, under_odds FROM market_snapshots
            WHERE game_id = mp.game_id AND market_type = 'totals'
            ORDER BY snapshot_time DESC LIMIT 1
        ) ms_tot ON TRUE
        WHERE mp.market_type = 'game'
          AND mp.p_home IS NULL
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()
    max_r = 15

    for row in rows:
        mu_h = row["model_mean_home"]
        mu_a = row["model_mean_away"]
        if not mu_h or not mu_a:
            continue

        # ── TRAP GAME SUPPRESSION (June 5) ────────────────────────────────────
        # If game_context.is_trap=True, write TRAP_SUPPRESSED and skip card output
        if row.get("is_trap"):
            update_cur.execute("""
                UPDATE model_predictions SET card_decision='TRAP_SUPPRESSED'
                WHERE id=%s
            """, (row["id"],))
            log.warning(f"TRAP_SUPPRESSED: game_id={row['game_id']}")
            continue

        # ── Bullpen Fatigue Multiplier (June 3 upgrade) ───────────────────────
        bp_home = _fetch_bp_fatigue(cur, row["home_team_id"], today)
        bp_away = _fetch_bp_fatigue(cur, row["away_team_id"], today)

        if bp_home >= BP_CRITICAL_IP:
            mu_h *= BP_CRITICAL_MULT
        elif bp_home >= BP_ELEVATED_IP:
            mu_h *= BP_ELEVATED_MULT

        if bp_away >= BP_CRITICAL_IP:
            mu_a *= BP_CRITICAL_MULT
        elif bp_away >= BP_ELEVATED_IP:
            mu_a *= BP_ELEVATED_MULT

        # ── Momentum Delta Layer (June 5) ──────────────────────────────────────
        # Adjusts model_mean by last-5 run differential to capture team momentum
        mom_home = _fetch_momentum_delta(cur, row["home_team_id"], today)
        mom_away = _fetch_momentum_delta(cur, row["away_team_id"], today)
        mu_h = mu_h * (1 + MOMENTUM_WEIGHT * np.tanh(mom_home / 5.0))
        mu_a = mu_a * (1 + MOMENTUM_WEIGHT * np.tanh(mom_away / 5.0))
        log.debug(f"Momentum adj: home={mom_home:.2f} -> mu_h={mu_h:.3f} | away={mom_away:.2f} -> mu_a={mu_a:.3f}")
        # ──────────────────────────────────────────────────────────────────────

        p_home = float(mu_h**gamma / (mu_h**gamma + mu_a**gamma))
        p_away = float(1 - p_home)
        probs_h = [float(poisson.pmf(k, mu_h)) for k in range(max_r + 1)]
        probs_a = [float(poisson.pmf(k, mu_a)) for k in range(max_r + 1)]
        probs_tot = [0.0] * (2 * max_r + 2)
        for i in range(max_r + 1):
            for j in range(max_r + 1):
                probs_tot[i + j] += probs_h[i] * probs_a[j]

        total_line = row["total_line"]
        p_over_tot  = float(sum(probs_tot[int(total_line) + 1:])) if total_line else None
        p_under_tot = float(1 - p_over_tot) if p_over_tot is not None else None

        p_imp_home  = implied_prob_american(row["home_odds"])
        p_imp_away  = implied_prob_american(row["away_odds"])
        p_imp_over  = implied_prob_american(row["total_over_odds"])
        p_imp_under = implied_prob_american(row["total_under_odds"])

        edge_home  = round(p_home - p_imp_home, 4)   if p_imp_home  else None
        edge_away  = round(p_away - p_imp_away, 4)   if p_imp_away  else None
        edge_over  = round(p_over_tot - p_imp_over, 4)   if p_imp_over  and p_over_tot  else None
        edge_under = round(p_under_tot - p_imp_under, 4) if p_imp_under and p_under_tot else None

        edges      = [e for e in [edge_home, edge_away, edge_over, edge_under] if e is not None]
        best_edge  = max(edges) if edges else None

        # ── Confidence floor (June 5) ─────────────────────────────────────────
        conf_home = p_home
        conf_away = p_away
        winning_side = "home" if p_home >= p_away else "away"
        winning_conf = max(conf_home, conf_away)
        winning_odds = row["home_odds"] if winning_side == "home" else row["away_odds"]

        if winning_conf < CONFIDENCE_FLOOR:
            decision = "LEAN"

        # ── Favorite Cliff Rule (June 5) ──────────────────────────────────────
        # Chalk plays past -180 need a secondary sharp signal or they're downgraded
        elif winning_odds is not None and winning_odds <= FAVORITE_CLIFF_ODDS:
            has_signal = _has_secondary_signal(cur, row["game_id"], winning_side)
            if not has_signal:
                decision = "LEAN"
                log.warning(f"FAVORITE_CLIFF downgrade: game_id={row['game_id']} side={winning_side} odds={winning_odds}")
            else:
                decision = "CANDIDATE" if best_edge and best_edge >= EDGE_THRESHOLD else "NO BET"

        else:
            decision = "CANDIDATE" if best_edge and best_edge >= EDGE_THRESHOLD else "NO BET"

        update_cur.execute("""
            UPDATE model_predictions SET
                p_home=%s, p_away=%s, p_over=%s, p_under=%s,
                edge_home=%s, edge_away=%s, edge_over=%s, edge_under=%s,
                home_odds=%s, away_odds=%s,
                line=%s, over_odds=%s, under_odds=%s,
                card_decision=%s
            WHERE id=%s
        """, (
            p_home, p_away, p_over_tot, p_under_tot,
            edge_home, edge_away, edge_over, edge_under,
            row["home_odds"], row["away_odds"],
            total_line, row["total_over_odds"], row["total_under_odds"],
            decision, row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_run_edges: processed {len(rows)} rows")
