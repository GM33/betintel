import os
import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import poisson, nbinom
from mlb.config import DATABASE_URL, EDGE_THRESHOLD, KELLY_FRACTION, MAX_STAKE_PCT
from mlb.features.weather_gate import get_weather_adjustment
from datetime import datetime
import logging

log = logging.getLogger("betintel.models.compute_edges")

# ── Bullpen fatigue thresholds (June 3) ───────────────────────────────────────────────
BP_CRITICAL_IP   = 18.0
BP_ELEVATED_IP   = 15.0
BP_CRITICAL_MULT = 1.12
BP_ELEVATED_MULT = 1.06

# ── Confidence floor & favorite cliff (Jun 5) ────────────────────────────────
CONFIDENCE_FLOOR    = 0.60
FAVORITE_CLIFF_ODDS = -220
MOMENTUM_WEIGHT     = 0.12  # TODO: wire into mu_h/mu_a in next PR

# ── K-prop gate & road blowout (Jun 3) ───────────────────────────────────────
K_PROP_WIN_PROB_GATE   = 0.60
ROAD_BLOWOUT_THRESHOLD = 5.0
ROAD_BLOWOUT_BOOST     = 0.15

# ── HIGH_VARIANCE band (Jun 6 r1) ─────────────────────────────────────────────
HIGH_VARIANCE_BAND = 0.65

# ── Away SP FIP edge minimum (Jun 6 r1) ──────────────────────────────────────
AWAY_SP_FIP_EDGE_MIN = 0.04

# ── CANDIDATE edge floor (Jun 6 r2) ─────────────────────────────────────────
CANDIDATE_EDGE_FLOOR = 0.055

# ── Undecided SP gate (Jun 6 r2) ─────────────────────────────────────────────
UNDECIDED_SP_GATE = True

# ── LOB variance flag (Jun 6 r2) ───────────────────────────────────────────────
LOB_VARIANCE_THRESHOLD  = 0.75
LOB_VARIANCE_MU_PENALTY = 0.08

# ── Negative Binomial dispersion (Jun 6 r4) ───────────────────────────────────
# Replaces Poisson for run scoring. MLB run distributions are overdispersed
# (variance > mean) — blowouts occur more often than Poisson predicts.
# NB(n=NB_DISPERSION, p=n/(n+mu)) with r=20 fits historical MLB run data well.
# K-prop edges continue using Poisson (strikeout counts are approx Poisson).
NB_DISPERSION = 20  # fitted to MLB run data; higher = closer to Poisson

# ── VALUE_DOG rule (Jun 5) ───────────────────────────────────────────────────────
VALUE_DOG_MIN_ODDS       = 120
VALUE_DOG_MAX_HOME_RD    = 20.0
VALUE_DOG_MAX_WRC_RANK   = 15
VALUE_DOG_BOOST          = 0.04
VALUE_DOG_WIN_TREND_GATE = True


def _nb_params(mu: float, r: float = NB_DISPERSION) -> tuple[float, float]:
    """
    Convert mean mu and dispersion r to scipy nbinom (n, p) parameterisation.
    nbinom(n, p) where n=r, p=r/(r+mu).
    """
    p = r / (r + mu)
    return r, p


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
    cur.execute("""
        SELECT bp_ip_last_3d FROM bullpen_stats
        WHERE team_id=%s AND date=%s
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] else 0.0

def _fetch_momentum_delta(cur, team_id, date_str):
    cur.execute("""
        SELECT AVG(run_diff_last5) FROM team_momentum
        WHERE team_id=%s AND date<=%s
        ORDER BY date DESC LIMIT 1
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0

def _fetch_road_momentum(cur, team_id, date_str):
    cur.execute("""
        SELECT AVG(road_run_diff_last5) FROM team_momentum
        WHERE team_id=%s AND date<=%s
        ORDER BY date DESC LIMIT 1
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0

def _fetch_lob_pct(cur, team_id, date_str):
    cur.execute("""
        SELECT lob_pct_last3 FROM team_batting_stats
        WHERE team_id=%s AND date<=%s
        ORDER BY date DESC LIMIT 1
    """, (team_id, date_str))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None

def _fetch_sp_confirmed(cur, game_id):
    cur.execute("""
        SELECT home_sp_confirmed, away_sp_confirmed
        FROM game_context WHERE game_id=%s
    """, (game_id,))
    row = cur.fetchone()
    if not row:
        return False, False
    return bool(row[0]), bool(row[1])

def _fetch_team_win_prob(cur, game_id, team_id):
    cur.execute("""
        SELECT p_home, p_away, gc.home_team_id
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        WHERE mp.game_id=%s AND mp.market_type='game'
        ORDER BY mp.created_at DESC LIMIT 1
    """, (game_id,))
    row = cur.fetchone()
    if not row:
        return None
    p_home, p_away, home_team_id = row
    return float(p_home) if team_id == home_team_id else float(p_away)

def _is_trap_game(cur, game_id):
    cur.execute("""
        SELECT is_trap FROM game_context WHERE game_id=%s
    """, (game_id,))
    row = cur.fetchone()
    return bool(row[0]) if row and row[0] is not None else False

def _has_secondary_signal(cur, game_id, side):
    """
    Returns True if any strong secondary signal exists for this game/side.
    Now reads Pinnacle sharp movement data written by pinnacle_lines.py.
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
    return (
        bool(line_moved_sharp) or
        (sharp_money_pct and sharp_money_pct >= 60) or
        (sp_fip_edge and sp_fip_edge >= AWAY_SP_FIP_EDGE_MIN)
    )

def _fetch_value_dog_inputs(cur, home_team_id, away_team_id, date_str):
    cur.execute("""
        SELECT season_run_diff FROM team_season_stats
        WHERE team_id=%s AND season=EXTRACT(YEAR FROM %s::date)
    """, (home_team_id, date_str))
    row = cur.fetchone()
    home_rd = float(row[0]) if row and row[0] is not None else None

    cur.execute("""
        SELECT wrc_plus_rank FROM team_season_stats
        WHERE team_id=%s AND season=EXTRACT(YEAR FROM %s::date)
    """, (away_team_id, date_str))
    row = cur.fetchone()
    away_wrc_rank = int(row[0]) if row and row[0] is not None else None

    cur.execute("""
        SELECT run_diff_last5 FROM team_momentum
        WHERE team_id=%s AND date<=%s
        ORDER BY date DESC LIMIT 1
    """, (away_team_id, date_str))
    row = cur.fetchone()
    away_last3_rd = float(row[0]) if row and row[0] is not None else None

    return home_rd, away_wrc_rank, away_last3_rd

def _fetch_home_team_code(cur, home_team_id):
    cur.execute("""
        SELECT team_code FROM teams WHERE team_id=%s
    """, (home_team_id,))
    row = cur.fetchone()
    return row[0] if row else None


def compute_k_edges():
    """
    K-prop edges use Poisson — strikeout counts are approximately Poisson
    distributed and do not exhibit the same overdispersion as run scoring.
    """
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT mp.id, mp.game_id, mp.player_id, mp.model_mean,
               ms.line, ms.over_odds, ms.under_odds, ms.player_name,
               gc.home_team_id, gc.away_team_id
        FROM model_predictions mp
        JOIN market_snapshots ms
          ON mp.game_id = ms.game_id
         AND mp.player_id = ms.player_id
         AND ms.market_type = 'player_prop'
         AND ms.prop_type = 'k_strikeouts'
        JOIN game_context gc ON mp.game_id = gc.game_id
        WHERE mp.market_type = 'player_prop'
          AND mp.p_over IS NULL
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()

    for row in rows:
        lam  = row["model_mean"]
        line = row["line"]
        if not lam or not line:
            continue

        # Poisson stays for K-props
        p_over  = float(1 - poisson.cdf(int(line), lam))
        p_under = float(poisson.cdf(int(line), lam))
        p_imp_over  = implied_prob_american(row["over_odds"])
        p_imp_under = implied_prob_american(row["under_odds"])
        edge_over  = round(p_over  - p_imp_over,  4) if p_imp_over  else None
        edge_under = round(p_under - p_imp_under, 4) if p_imp_under else None
        edges     = [e for e in [edge_over, edge_under] if e is not None]
        best_edge = max(edges) if edges else None
        best_conf = max(p_over, p_under)

        k_over_gated = False
        if edge_over and edge_over == best_edge:
            # FIX (Jun 7 audit): was incorrectly passing row["player_id"] — a player ID
            # never matches home_team_id so _fetch_team_win_prob always returned p_away.
            # Now look up which team the pitcher belongs to via game_context, then pass
            # the correct team_id so the home/away branch resolves properly.
            cur.execute("""
                SELECT sp_team_id FROM game_context
                WHERE game_id=%s AND (home_sp_player_id=%s OR away_sp_player_id=%s)
                LIMIT 1
            """, (row["game_id"], row["player_id"], row["player_id"]))
            sp_row = cur.fetchone()
            if sp_row:
                sp_team_id = sp_row[0]
            else:
                # Fallback: if we can't resolve the SP's team, use home_team_id
                sp_team_id = row["home_team_id"]
                log.warning(
                    f"K_PROP_WIN_PROB: could not resolve sp_team_id for "
                    f"player_id={row['player_id']} game_id={row['game_id']} — using home"
                )

            team_win_prob = _fetch_team_win_prob(cur, row["game_id"], sp_team_id)
            if team_win_prob is not None and team_win_prob < K_PROP_WIN_PROB_GATE:
                k_over_gated = True
                log.warning(
                    f"K_OVER_GATED: player_id={row['player_id']} game_id={row['game_id']} "
                    f"sp_team_id={sp_team_id} team_win_prob={team_win_prob:.3f} < {K_PROP_WIN_PROB_GATE}"
                )

        if best_conf < CONFIDENCE_FLOOR or k_over_gated:
            decision = "LEAN"
        else:
            decision = "CANDIDATE" if best_edge and best_edge >= CANDIDATE_EDGE_FLOOR else "NO BET"

        staking = None
        if decision == "CANDIDATE":
            if edge_over and edge_over == best_edge:
                staking = kelly_stake(p_over, row["over_odds"])
            else:
                staking = kelly_stake(p_under, row["under_odds"])
        elif decision == "LEAN":
            staking = 0.005

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


def compute_run_edges():
    """
    Run scoring now uses Negative Binomial instead of Poisson.
    NB(n=NB_DISPERSION, p=n/(n+mu)) captures the overdispersion in real
    MLB run distributions — blowout games are priced correctly.

    FIX (Jun 7 audit): removed dead gamma=1.86 parameter (park factor leftover,
    never referenced in body). Use NB_DISPERSION module constant instead of
    hardcoded local max_r=20.
    """
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
    # FIX (Jun 7 audit): use module constant NB_DISPERSION — not hardcoded 20
    max_r = NB_DISPERSION

    for row in rows:
        mu_h = row["model_mean_home"]
        mu_a = row["model_mean_away"]
        if not mu_h or not mu_a:
            continue

        # ── TRAP GAME SUPPRESSION ─────────────────────────────────────────────
        if row.get("is_trap"):
            update_cur.execute("""
                UPDATE model_predictions SET card_decision='TRAP_SUPPRESSED'
                WHERE id=%s
            """, (row["id"],))
            log.warning(f"TRAP_SUPPRESSED: game_id={row['game_id']}")
            continue

        # ── UNDECIDED SP GATE ─────────────────────────────────────────────────
        if UNDECIDED_SP_GATE:
            home_confirmed, away_confirmed = _fetch_sp_confirmed(cur, row["game_id"])
            if not home_confirmed or not away_confirmed:
                update_cur.execute("""
                    UPDATE model_predictions SET card_decision='SP_UNCONFIRMED'
                    WHERE id=%s
                """, (row["id"],))
                log.warning(
                    f"SP_UNCONFIRMED: game_id={row['game_id']} "
                    f"home={home_confirmed} away={away_confirmed}"
                )
                continue

        # ── WEATHER GATE ──────────────────────────────────────────────────────
        home_code = _fetch_home_team_code(cur, row["home_team_id"])
        wx_mult, rain_gate, wx_meta = get_weather_adjustment(home_code or "")
        if rain_gate:
            update_cur.execute("""
                UPDATE model_predictions SET card_decision='WEATHER_LEAN'
                WHERE id=%s
            """, (row["id"],))
            log.warning(f"WEATHER_LEAN: game_id={row['game_id']} wx={wx_meta}")
            continue

        # Apply weather multiplier to run means
        mu_h = mu_h * wx_mult
        mu_a = mu_a * wx_mult

        # ── LOB VARIANCE PENALTY ──────────────────────────────────────────────
        lob_h = _fetch_lob_pct(cur, row["home_team_id"], today)
        lob_a = _fetch_lob_pct(cur, row["away_team_id"], today)
        if lob_h and lob_h >= LOB_VARIANCE_THRESHOLD:
            mu_h = mu_h * (1 - LOB_VARIANCE_MU_PENALTY)
        if lob_a and lob_a >= LOB_VARIANCE_THRESHOLD:
            mu_a = mu_a * (1 - LOB_VARIANCE_MU_PENALTY)

        # ── BULLPEN FATIGUE ───────────────────────────────────────────────────
        bp_h = _fetch_bp_fatigue(cur, row["home_team_id"], today)
        bp_a = _fetch_bp_fatigue(cur, row["away_team_id"], today)
        if bp_h >= BP_CRITICAL_IP:
            mu_h = mu_h * BP_CRITICAL_MULT
        elif bp_h >= BP_ELEVATED_IP:
            mu_h = mu_h * BP_ELEVATED_MULT
        if bp_a >= BP_CRITICAL_IP:
            mu_a = mu_a * BP_CRITICAL_MULT
        elif bp_a >= BP_ELEVATED_IP:
            mu_a = mu_a * BP_ELEVATED_MULT

        # ── ROAD BLOWOUT DEFENSE ──────────────────────────────────────────────
        road_mom = _fetch_road_momentum(cur, row["away_team_id"], today)
        home_mom = _fetch_momentum_delta(cur, row["home_team_id"], today)
        road_blowout_risk = (road_mom - home_mom) >= ROAD_BLOWOUT_THRESHOLD
        if road_blowout_risk:
            mu_a = mu_a * (1 + ROAD_BLOWOUT_BOOST)
            log.info(
                f"ROAD_BLOWOUT_BOOST: game_id={row['game_id']} "
                f"road_mom={road_mom:.2f} home_mom={home_mom:.2f}"
            )

        # ── NEGATIVE BINOMIAL RUN PROBABILITIES ──────────────────────────────
        n_h, p_h = _nb_params(mu_h, max_r)
        n_a, p_a = _nb_params(mu_a, max_r)

        # Win probabilities via Monte Carlo NB samples
        rng = np.random.default_rng(seed=42)
        sims = 50_000
        runs_h = nbinom.rvs(n_h, p_h, size=sims, random_state=rng)
        runs_a = nbinom.rvs(n_a, p_a, size=sims, random_state=rng)
        p_home_win = float(np.mean(runs_h > runs_a))
        p_away_win = float(np.mean(runs_a > runs_h))
        # Normalise (ties → split proportionally)
        total = p_home_win + p_away_win
        if total > 0:
            p_home_win /= total
            p_away_win /= total

        # Totals
        total_runs = runs_h + runs_a
        total_line = row["total_line"]
        p_over  = float(np.mean(total_runs > total_line)) if total_line else None
        p_under = float(np.mean(total_runs < total_line)) if total_line else None

        # ── ML EDGE CALCULATION ───────────────────────────────────────────────
        imp_home = implied_prob_american(row["home_odds"])
        imp_away = implied_prob_american(row["away_odds"])
        edge_home = round(p_home_win - imp_home, 4) if imp_home else None
        edge_away = round(p_away_win - imp_away, 4) if imp_away else None

        # ── CONFIDENCE FLOOR ─────────────────────────────────────────────────
        best_conf = max(p_home_win, p_away_win)
        if best_conf < CONFIDENCE_FLOOR:
            decision = "LEAN"
        else:
            best_edge = max(
                [e for e in [edge_home, edge_away] if e is not None],
                default=None
            )
            decision = "CANDIDATE" if best_edge and best_edge >= CANDIDATE_EDGE_FLOOR else "NO BET"

        # ── FAVORITE CLIFF ───────────────────────────────────────────────────
        if decision == "CANDIDATE":
            fav_odds = row["home_odds"] if p_home_win > p_away_win else row["away_odds"]
            if fav_odds and fav_odds < FAVORITE_CLIFF_ODDS:
                decision = "LEAN"
                log.info(
                    f"FAVORITE_CLIFF: game_id={row['game_id']} "
                    f"fav_odds={fav_odds} < {FAVORITE_CLIFF_ODDS}"
                )

        # ── HIGH_VARIANCE SUPPRESSOR ─────────────────────────────────────────
        if decision == "CANDIDATE":
            variance_score = abs(p_home_win - 0.5) * 2  # 0=coin flip, 1=certainty
            if variance_score < HIGH_VARIANCE_BAND:
                secondary = _has_secondary_signal(cur, row["game_id"], "home" if p_home_win > p_away_win else "away")
                if not secondary:
                    decision = "LEAN"
                    log.info(
                        f"HIGH_VARIANCE_SUPPRESSED: game_id={row['game_id']} "
                        f"variance_score={variance_score:.3f} no secondary signal"
                    )

        # ── VALUE_DOG CHECK ──────────────────────────────────────────────────
        if decision in ("LEAN", "NO BET"):
            dog_odds = row["away_odds"]
            if dog_odds and dog_odds >= VALUE_DOG_MIN_ODDS:
                home_rd, away_wrc_rank, away_last3_rd = _fetch_value_dog_inputs(
                    cur, row["home_team_id"], row["away_team_id"], today
                )
                if (
                    home_rd is not None and home_rd <= VALUE_DOG_MAX_HOME_RD and
                    away_wrc_rank is not None and away_wrc_rank <= VALUE_DOG_MAX_WRC_RANK and
                    (not VALUE_DOG_WIN_TREND_GATE or (away_last3_rd is not None and away_last3_rd > 0))
                ):
                    p_away_win = min(p_away_win + VALUE_DOG_BOOST, 0.99)
                    edge_away = round(p_away_win - imp_away, 4) if imp_away else edge_away
                    decision = "CANDIDATE"
                    log.info(
                        f"VALUE_DOG_UPGRADE: game_id={row['game_id']} "
                        f"away_odds={dog_odds} home_rd={home_rd} away_wrc={away_wrc_rank}"
                    )

        # ── STAKING ───────────────────────────────────────────────────────────
        staking = None
        if decision == "CANDIDATE":
            if edge_home and (edge_away is None or edge_home >= edge_away):
                staking = kelly_stake(p_home_win, row["home_odds"])
            else:
                staking = kelly_stake(p_away_win, row["away_odds"])
        elif decision == "LEAN":
            staking = 0.005

        update_cur.execute("""
            UPDATE model_predictions SET
                p_home=%s, p_away=%s,
                edge_home=%s, edge_away=%s,
                p_over=%s, p_under=%s,
                card_decision=%s, staking_pct=%s,
                weather_mult=%s
            WHERE id=%s
        """, (
            p_home_win, p_away_win,
            edge_home, edge_away,
            p_over, p_under,
            decision, staking,
            wx_mult,
            row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_run_edges: processed {len(rows)} rows")
