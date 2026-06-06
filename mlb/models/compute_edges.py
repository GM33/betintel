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
MOMENTUM_WEIGHT     = 0.12

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
            team_win_prob = _fetch_team_win_prob(cur, row["game_id"], row["player_id"])
            if team_win_prob is not None and team_win_prob < K_PROP_WIN_PROB_GATE:
                k_over_gated = True
                log.warning(
                    f"K_OVER_GATED: player_id={row['player_id']} game_id={row['game_id']} "
                    f"team_win_prob={team_win_prob:.3f} < {K_PROP_WIN_PROB_GATE}"
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


def compute_run_edges(gamma: float = 1.86):
    """
    Run scoring now uses Negative Binomial instead of Poisson.
    NB(n=NB_DISPERSION, p=n/(n+mu)) captures the overdispersion in real
    MLB run distributions — blowout games are priced correctly.
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
    max_r = 20  # raised from 15 — NB has heavier tails than Poisson

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

        # ── UNDECIDED SP GATE ──────────────────────────────────────────────────
        if UNDECIDED_SP_GATE:
            home_sp_ok, away_sp_ok = _fetch_sp_confirmed(cur, row["game_id"])
            if not home_sp_ok or not away_sp_ok:
                update_cur.execute("""
                    UPDATE model_predictions SET card_decision='LEAN', staking_pct=0.005
                    WHERE id=%s
                """, (row["id"],))
                log.warning(
                    f"UNDECIDED_SP_GATE: game_id={row['game_id']} "
                    f"home_sp_ok={home_sp_ok} away_sp_ok={away_sp_ok} -> LEAN"
                )
                continue

        # ── Bullpen Fatigue Multiplier ────────────────────────────────────────
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

        # ── LOB Variance Flag ───────────────────────────────────────────────────────
        lob_home = _fetch_lob_pct(cur, row["home_team_id"], today)
        lob_away = _fetch_lob_pct(cur, row["away_team_id"], today)
        if lob_home is not None and lob_home > LOB_VARIANCE_THRESHOLD:
            mu_h *= (1 - LOB_VARIANCE_MU_PENALTY)
            log.info(f"LOB_VARIANCE_PENALTY home: team={row['home_team_id']} lob={lob_home:.3f}")
        if lob_away is not None and lob_away > LOB_VARIANCE_THRESHOLD:
            mu_a *= (1 - LOB_VARIANCE_MU_PENALTY)
            log.info(f"LOB_VARIANCE_PENALTY away: team={row['away_team_id']} lob={lob_away:.3f}")

        # ── Momentum Delta Layer ──────────────────────────────────────────────
        mom_home = _fetch_momentum_delta(cur, row["home_team_id"], today)
        mom_away = _fetch_momentum_delta(cur, row["away_team_id"], today)
        mu_h = mu_h * (1 + MOMENTUM_WEIGHT * np.tanh(mom_home / 5.0))
        mu_a = mu_a * (1 + MOMENTUM_WEIGHT * np.tanh(mom_away / 5.0))

        # ── Road Blowout Defense ──────────────────────────────────────────────
        road_mom_away = _fetch_road_momentum(cur, row["away_team_id"], today)
        if road_mom_away >= ROAD_BLOWOUT_THRESHOLD:
            mu_a = mu_a * (1 + ROAD_BLOWOUT_BOOST)
            log.info(
                f"ROAD_BLOWOUT_BOOST: away_team={row['away_team_id']} "
                f"road_run_diff={road_mom_away:.2f} -> mu_a={mu_a:.3f}"
            )

        # ── Weather Gate ────────────────────────────────────────────────────────
        home_team_code = _fetch_home_team_code(cur, row["home_team_id"])
        wx_mult, rain_gate, wx_meta = get_weather_adjustment(
            home_team_code, game_hour_idx=0
        )
        if rain_gate:
            update_cur.execute("""
                UPDATE model_predictions SET
                    card_decision='LEAN', staking_pct=0.005,
                    weather_temp_f=%s, weather_wind_mph=%s,
                    weather_wind_deg=%s, weather_rain_prob=%s,
                    weather_multiplier=%s, weather_gate_triggered=TRUE
                WHERE id=%s
            """, (
                wx_meta.get("temp_f"), wx_meta.get("wind_mph"),
                wx_meta.get("wind_deg"), wx_meta.get("rain_prob"),
                wx_mult, row["id"],
            ))
            log.warning(f"WEATHER_RAIN_GATE: game_id={row['game_id']} park={home_team_code}")
            continue
        mu_h *= wx_mult
        mu_a *= wx_mult

        # ── Win probability via Bradley-Terry (unchanged) ───────────────────────
        p_home = float(mu_h**gamma / (mu_h**gamma + mu_a**gamma))
        p_away = float(1 - p_home)

        # ── VALUE_DOG Rule ────────────────────────────────────────────────────
        value_dog_triggered = False
        away_odds = row["away_odds"]
        if away_odds is not None and away_odds >= VALUE_DOG_MIN_ODDS:
            home_rd, away_wrc_rank, away_last3_rd = _fetch_value_dog_inputs(
                cur, row["home_team_id"], row["away_team_id"], today
            )
            has_sharp = _has_secondary_signal(cur, row["game_id"], "away")
            away_trend_ok = (
                not VALUE_DOG_WIN_TREND_GATE or
                (away_last3_rd is not None and away_last3_rd >= 0) or
                has_sharp
            )
            if (
                home_rd is not None and home_rd <= VALUE_DOG_MAX_HOME_RD and
                away_wrc_rank is not None and away_wrc_rank <= VALUE_DOG_MAX_WRC_RANK and
                away_trend_ok
            ):
                p_away = min(p_away * (1 + VALUE_DOG_BOOST), 0.99)
                p_home = 1 - p_away
                value_dog_triggered = True
                log.info(f"VALUE_DOG: game_id={row['game_id']} -> p_away={p_away:.3f}")

        # ── Run total probabilities — NEGATIVE BINOMIAL (replaces Poisson) ──────
        # Each team's run distribution is modelled as NB(n=NB_DISPERSION, p=n/(n+mu))
        # which has mean=mu and variance=mu + mu^2/r > mu (overdispersed vs Poisson).
        # Joint distribution is computed as convolution of the two NB marginals,
        # identical in structure to the old Poisson convolution.
        n_h, p_nb_h = _nb_params(mu_h)
        n_a, p_nb_a = _nb_params(mu_a)
        probs_h   = [float(nbinom.pmf(k, n_h, p_nb_h)) for k in range(max_r + 1)]
        probs_a   = [float(nbinom.pmf(k, n_a, p_nb_a)) for k in range(max_r + 1)]
        probs_tot = [0.0] * (2 * max_r + 2)
        for i in range(max_r + 1):
            for j in range(max_r + 1):
                probs_tot[i + j] += probs_h[i] * probs_a[j]

        total_line  = row["total_line"]
        model_total = mu_h + mu_a
        p_over_tot  = float(sum(probs_tot[int(total_line) + 1:])) if total_line else None
        p_under_tot = float(1 - p_over_tot) if p_over_tot is not None else None

        p_imp_home  = implied_prob_american(row["home_odds"])
        p_imp_away  = implied_prob_american(row["away_odds"])
        p_imp_over  = implied_prob_american(row["total_over_odds"])
        p_imp_under = implied_prob_american(row["total_under_odds"])

        edge_home  = round(p_home  - p_imp_home,  4) if p_imp_home              else None
        edge_away  = round(p_away  - p_imp_away,  4) if p_imp_away              else None
        edge_over  = round(p_over_tot  - p_imp_over,  4) if p_imp_over  and p_over_tot  else None
        edge_under = round(p_under_tot - p_imp_under, 4) if p_imp_under and p_under_tot else None

        edges     = [e for e in [edge_home, edge_away, edge_over, edge_under] if e is not None]
        best_edge = max(edges) if edges else None

        # ── HIGH_VARIANCE Suppressor ──────────────────────────────────────────
        high_variance = (
            total_line is not None and
            abs(model_total - float(total_line)) <= HIGH_VARIANCE_BAND
        )

        # ── Decision logic ───────────────────────────────────────────────────────
        winning_side = "home" if p_home >= p_away else "away"
        winning_conf = max(p_home, p_away)
        winning_odds = row["home_odds"] if winning_side == "home" else row["away_odds"]

        if winning_conf < CONFIDENCE_FLOOR:
            decision = "LEAN"
        elif winning_odds is not None and winning_odds <= FAVORITE_CLIFF_ODDS:
            has_signal = _has_secondary_signal(cur, row["game_id"], winning_side)
            decision = "CANDIDATE" if has_signal and best_edge and best_edge >= CANDIDATE_EDGE_FLOOR else "LEAN"
            if decision == "LEAN":
                log.warning(f"FAVORITE_CLIFF: game_id={row['game_id']} side={winning_side} odds={winning_odds}")
        elif best_edge and best_edge < CANDIDATE_EDGE_FLOOR:
            decision = "LEAN"
            log.info(f"EDGE_FLOOR_DOWNGRADE: game_id={row['game_id']} best_edge={best_edge:.4f} -> LEAN")
        else:
            decision = "CANDIDATE" if best_edge and best_edge >= CANDIDATE_EDGE_FLOOR else "NO BET"

        staking_override = 0.005 if high_variance and decision == "CANDIDATE" else None

        update_cur.execute("""
            UPDATE model_predictions SET
                p_home=%s, p_away=%s, p_over=%s, p_under=%s,
                edge_home=%s, edge_away=%s, edge_over=%s, edge_under=%s,
                home_odds=%s, away_odds=%s,
                line=%s, over_odds=%s, under_odds=%s,
                card_decision=%s,
                staking_pct=COALESCE(%s, staking_pct),
                high_variance=%s, value_dog=%s,
                weather_temp_f=%s, weather_wind_mph=%s,
                weather_wind_deg=%s, weather_rain_prob=%s,
                weather_multiplier=%s, weather_gate_triggered=FALSE
            WHERE id=%s
        """, (
            p_home, p_away, p_over_tot, p_under_tot,
            edge_home, edge_away, edge_over, edge_under,
            row["home_odds"], row["away_odds"],
            total_line, row["total_over_odds"], row["total_under_odds"],
            decision, staking_override,
            high_variance, value_dog_triggered,
            wx_meta.get("temp_f"), wx_meta.get("wind_mph"),
            wx_meta.get("wind_deg"), wx_meta.get("rain_prob"),
            wx_mult, row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_run_edges: processed {len(rows)} rows")
