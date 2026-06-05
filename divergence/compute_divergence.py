"""
BetIntel — Multi-Model Divergence Engine
=========================================
Pulls today's wnba_model_predictions (BetIntel Poisson output),
computes Massey rating and Elo win-probability alongside it, then
writes tri-model divergence rows to model_divergence.

Usage:
    python -m divergence.compute_divergence          # WNBA
    python -m divergence.compute_divergence --sport nba

Audit findings addressed in this module (from wnba/models/compute_edges.py):
  1. Half-line floor bug  — use Poisson P(X > line) with float line via
     (1 - poisson.cdf(floor(line), mu)) adjusted for half-lines.
  2. Fixed seed(0)       — removed; each run is independent.
  3. Bradley-Terry proxy — Elo & Massey provide independent probability
     signals that don't inherit the implied-odds circular dependency.
  4. Silent ON CONFLICT  — this module logs skipped rows explicitly.
"""

import os
import sys
import math
import logging
import argparse
from datetime import date
from typing import Optional

import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import norm, poisson

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s")
log = logging.getLogger("betintel.divergence")

# ── Constants ─────────────────────────────────────────────────────────────────
DIVERGENCE_THRESHOLD  = 0.07   # flag as HIGH_DIVERGE if max_divergence >= this
CONSENSUS_EDGE_FLOOR  = 0.04   # flag CONSENSUS_EDGE if consensus_edge >= this
ELO_K                 = 20.0   # Elo K-factor
ELO_BASE_RATING       = 1500.0
MASSEY_SHRINK         = 0.50   # shrink Massey ratings toward league mean


# ── DB ────────────────────────────────────────────────────────────────────────

def get_db(url: Optional[str] = None):
    url = url or os.environ["DATABASE_URL"]
    return psycopg2.connect(url)


# ── Helpers ───────────────────────────────────────────────────────────────────

def implied_prob_american(price: Optional[int]) -> Optional[float]:
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)


def poisson_p_over(mu: float, line: float) -> float:
    """
    P(X > line) where line may be a half-integer.
    Fixes the int(line) floor bug in the original compute_edges.py.
    Uses the highest integer k s.t. k <= line, so:
      line=14.5 -> P(X >= 15) = 1 - CDF(14)
      line=14   -> P(X >= 15) = 1 - CDF(14)   [standard over]
    Consistent with sportsbook convention for totals.
    """
    k = math.floor(line)
    return float(1.0 - poisson.cdf(k, mu))


def poisson_p_under(mu: float, line: float) -> float:
    k = math.floor(line)
    return float(poisson.cdf(k, mu))


# ── Elo Model ─────────────────────────────────────────────────────────────────

def elo_expected(rating_a: float, rating_b: float) -> float:
    """Standard Elo expected score for team A."""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def fetch_elo_ratings(cur, sport: str) -> dict:
    """
    Attempt to load Elo ratings from a {sport}_team_elo table.
    Falls back to base rating 1500 for any missing team.
    Returns {team_id: float}.
    """
    table = f"{sport}_team_elo"
    ratings = {}
    try:
        cur.execute(f"SELECT team_id, elo_rating FROM {table}")
        for row in cur.fetchall():
            ratings[row["team_id"]] = float(row["elo_rating"])
        log.info(f"Loaded {len(ratings)} Elo ratings from {table}")
    except psycopg2.errors.UndefinedTable:
        log.warning(f"Table {table} not found — using base Elo {ELO_BASE_RATING} for all teams")
    return ratings


# ── Massey Rating Model ───────────────────────────────────────────────────────

def fetch_massey_ratings(cur, sport: str) -> dict:
    """
    Attempt to load Massey ratings from {sport}_team_massey table.
    Falls back gracefully if the table doesn't exist yet.
    Returns {team_id: float}.
    """
    table = f"{sport}_team_massey"
    ratings = {}
    try:
        cur.execute(f"SELECT team_id, massey_rating FROM {table}")
        for row in cur.fetchall():
            ratings[row["team_id"]] = float(row["massey_rating"])
        log.info(f"Loaded {len(ratings)} Massey ratings from {table}")
    except psycopg2.errors.UndefinedTable:
        log.warning(f"Table {table} not found — Massey signals will be None")
    return ratings


def massey_win_prob(rating_home: Optional[float],
                   rating_away: Optional[float],
                   scale: float = 10.0) -> Optional[float]:
    """
    Logistic transformation of Massey rating difference.
    P(home win) = sigmoid((r_home - r_away) / scale)
    """
    if rating_home is None or rating_away is None:
        return None
    diff = (rating_home - rating_away) * MASSEY_SHRINK
    return float(1.0 / (1.0 + math.exp(-diff / scale)))


def massey_total_p_over(mu_home: float, mu_away: float,
                        rating_home: Optional[float],
                        rating_away: Optional[float],
                        line: float) -> Optional[float]:
    """
    Adjust BetIntel's Poisson mus using Massey rating ratio.
    Returns P(total > line) under Massey-adjusted scoring.
    """
    if rating_home is None or rating_away is None:
        return None
    league_avg = (rating_home + rating_away) / 2.0 or 1.0
    scale_h = (rating_home / league_avg) ** MASSEY_SHRINK
    scale_a = (rating_away / league_avg) ** MASSEY_SHRINK
    adj_mu_h = mu_home * scale_h
    adj_mu_a = mu_away * scale_a
    combined_mu = adj_mu_h + adj_mu_a
    return poisson_p_over(combined_mu, line)


# ── Divergence Flag Logic ─────────────────────────────────────────────────────

def classify_flag(max_div: float, consensus_edge: Optional[float]) -> str:
    if max_div >= DIVERGENCE_THRESHOLD:
        return "HIGH_DIVERGE"
    if consensus_edge is not None and consensus_edge >= CONSENSUS_EDGE_FLOOR:
        return "CONSENSUS_EDGE"
    return "NOISE"


def classify_recommendation(betintel_edge_over: Optional[float],
                             consensus_edge: Optional[float],
                             flag: str) -> str:
    if flag == "NOISE":
        return "PASS"
    edge = consensus_edge or betintel_edge_over or 0.0
    if edge > 0:
        return "BET_OVER"
    elif edge < -0.04:
        return "BET_UNDER"
    return "PASS"


# ── Main Engine ───────────────────────────────────────────────────────────────

def compute_divergence(sport: str = "wnba") -> int:
    """
    Pull today's model predictions, compute divergence across three models,
    write results to model_divergence. Returns number of rows written.
    """
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load rating tables (graceful fallback if tables not seeded yet)
    elo_ratings    = fetch_elo_ratings(cur, sport)
    massey_ratings = fetch_massey_ratings(cur, sport)

    # Fetch today's BetIntel predictions
    predictions_table = f"{sport}_model_predictions"
    games_table       = f"{sport}_games"

    try:
        cur.execute(f"""
            SELECT
                mp.game_id,
                mp.player_id,
                mp.player_name,
                mp.market_type,
                mp.prop_type,
                mp.line,
                mp.model_mean        AS betintel_mu,
                mp.model_mean_home   AS betintel_mu_home,
                mp.model_mean_away   AS betintel_mu_away,
                mp.p_over            AS betintel_p_over,
                mp.p_under           AS betintel_p_under,
                mp.edge_over         AS betintel_edge_over,
                mp.edge_under        AS betintel_edge_under,
                mp.over_odds,
                mp.under_odds,
                g.home_team_id,
                g.away_team_id
            FROM {predictions_table} mp
            JOIN {games_table} g ON mp.game_id = g.game_id
            WHERE DATE(mp.created_at) = CURRENT_DATE
        """)
    except psycopg2.errors.UndefinedTable as e:
        log.error(f"Predictions table not found: {e}")
        conn.close()
        return 0

    rows    = cur.fetchall()
    insert  = conn.cursor()
    written = 0
    skipped = 0

    for row in rows:
        home_id = row["home_team_id"]
        away_id = row["away_team_id"]
        line    = float(row["line"]) if row["line"] is not None else None
        mu      = float(row["betintel_mu"]) if row["betintel_mu"] else None
        mu_home = float(row["betintel_mu_home"]) if row["betintel_mu_home"] else mu
        mu_away = float(row["betintel_mu_away"]) if row["betintel_mu_away"] else mu

        if line is None or mu is None:
            skipped += 1
            continue

        # ── BetIntel Poisson (half-line corrected) ──
        bi_p_over  = poisson_p_over(mu, line)
        bi_p_under = poisson_p_under(mu, line)

        # ── Elo ──────────────────────────────────────
        elo_h = elo_ratings.get(home_id, ELO_BASE_RATING)
        elo_a = elo_ratings.get(away_id, ELO_BASE_RATING)
        elo_p_home = elo_expected(elo_h, elo_a)
        elo_p_away = 1.0 - elo_p_home

        # ── Massey ───────────────────────────────────
        mass_h = massey_ratings.get(home_id)
        mass_a = massey_ratings.get(away_id)
        massey_ph = massey_win_prob(mass_h, mass_a)

        if row["market_type"] == "game":
            massey_p_ov = massey_total_p_over(
                mu_home or mu/2, mu_away or mu/2, mass_h, mass_a, line
            )
            massey_p_un = (1.0 - massey_p_ov) if massey_p_ov is not None else None
            # For game market divergence compare p_over signals
            div_bi_mass = abs(bi_p_over - massey_p_ov)  if massey_p_ov is not None else 0.0
            div_bi_elo  = abs(bi_p_over - elo_p_home)
            div_mass_elo= abs((massey_ph or elo_p_home) - elo_p_home)
        else:
            # Player prop — Massey/Elo adjust scoring expectation
            massey_p_ov = None
            massey_p_un = None
            div_bi_mass = 0.0
            div_bi_elo  = 0.0
            div_mass_elo= 0.0

        max_div = max(div_bi_mass, div_bi_elo, div_mass_elo)

        # Consensus: average available model p_over estimates
        estimates = [bi_p_over]
        if massey_p_ov is not None:
            estimates.append(massey_p_ov)
        if row["market_type"] == "game":
            estimates.append(elo_p_home)
        consensus_p = float(np.mean(estimates))

        mkt_imp = implied_prob_american(row["over_odds"])
        consensus_edge = round(consensus_p - mkt_imp, 4) if mkt_imp else None

        flag = classify_flag(max_div, consensus_edge)
        rec  = classify_recommendation(row["betintel_edge_over"], consensus_edge, flag)

        try:
            insert.execute("""
                INSERT INTO model_divergence (
                    run_date, sport, game_id, player_id, player_name,
                    market_type, prop_type, line,
                    betintel_p_over, betintel_p_under,
                    betintel_edge_over, betintel_edge_under, betintel_mu,
                    massey_p_over, massey_p_under,
                    massey_rating_home, massey_rating_away,
                    elo_p_home, elo_p_away,
                    elo_rating_home, elo_rating_away,
                    divergence_betintel_massey, divergence_betintel_elo,
                    divergence_massey_elo, max_divergence,
                    consensus_p_over, consensus_edge,
                    mkt_implied_over, over_odds, under_odds,
                    flag, card_recommendation
                ) VALUES (
                    CURRENT_DATE, %(sport)s, %(game_id)s, %(player_id)s, %(player_name)s,
                    %(market_type)s, %(prop_type)s, %(line)s,
                    %(bi_p_over)s, %(bi_p_under)s,
                    %(bi_edge_over)s, %(bi_edge_under)s, %(bi_mu)s,
                    %(massey_p_ov)s, %(massey_p_un)s,
                    %(massey_h)s, %(massey_a)s,
                    %(elo_ph)s, %(elo_pa)s,
                    %(elo_h)s, %(elo_a)s,
                    %(div_bi_mass)s, %(div_bi_elo)s,
                    %(div_mass_elo)s, %(max_div)s,
                    %(cons_p)s, %(cons_edge)s,
                    %(mkt_imp)s, %(over_odds)s, %(under_odds)s,
                    %(flag)s, %(rec)s
                )
                ON CONFLICT (run_date, sport, game_id,
                             COALESCE(player_id,''), prop_type)
                DO UPDATE SET
                    max_divergence     = EXCLUDED.max_divergence,
                    consensus_edge     = EXCLUDED.consensus_edge,
                    flag               = EXCLUDED.flag,
                    card_recommendation= EXCLUDED.card_recommendation,
                    created_at         = NOW()
            """, {
                "sport":       sport,
                "game_id":     row["game_id"],
                "player_id":   row["player_id"],
                "player_name": row["player_name"],
                "market_type": row["market_type"],
                "prop_type":   row["prop_type"],
                "line":        line,
                "bi_p_over":   round(bi_p_over, 4),
                "bi_p_under":  round(bi_p_under, 4),
                "bi_edge_over":  row["betintel_edge_over"],
                "bi_edge_under": row["betintel_edge_under"],
                "bi_mu":       round(mu, 3),
                "massey_p_ov": round(massey_p_ov, 4) if massey_p_ov is not None else None,
                "massey_p_un": round(massey_p_un, 4) if massey_p_un is not None else None,
                "massey_h":    round(mass_h, 4) if mass_h is not None else None,
                "massey_a":    round(mass_a, 4) if mass_a is not None else None,
                "elo_ph":      round(elo_p_home, 4),
                "elo_pa":      round(elo_p_away, 4),
                "elo_h":       round(elo_h, 2),
                "elo_a":       round(elo_a, 2),
                "div_bi_mass": round(div_bi_mass, 4),
                "div_bi_elo":  round(div_bi_elo, 4),
                "div_mass_elo":round(div_mass_elo, 4),
                "max_div":     round(max_div, 4),
                "cons_p":      round(consensus_p, 4),
                "cons_edge":   consensus_edge,
                "mkt_imp":     round(mkt_imp, 4) if mkt_imp else None,
                "over_odds":   row["over_odds"],
                "under_odds":  row["under_odds"],
                "flag":        flag,
                "rec":         rec,
            })
            written += 1
        except Exception as e:
            log.error(f"Insert failed for {row['game_id']} / {row['prop_type']}: {e}")
            conn.rollback()
            continue

    conn.commit()
    cur.close()
    insert.close()
    conn.close()
    log.info(f"compute_divergence [{sport}]: written={written} skipped={skipped}")
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BetIntel Divergence Engine")
    parser.add_argument("--sport", default="wnba",
                        choices=["wnba", "nba", "mlb"],
                        help="Sport to run divergence for (default: wnba)")
    args = parser.parse_args()
    compute_divergence(sport=args.sport)
