import psycopg2
import psycopg2.extras
import numpy as np
from scipy.stats import poisson
from wnba.config import (
    DATABASE_URL, EDGE_THRESHOLD, KELLY_FRACTION, MAX_STAKE_PCT,
    BRADLEY_TERRY_GAMMA, MIN_MINUTES_PROJ, MIN_GAMES_PLAYED,
    HIGH_CONF_EDGE, MED_CONF_EDGE
)
from datetime import datetime
import logging

log = logging.getLogger("betintel.wnba.models.compute_edges")


def get_db():
    return psycopg2.connect(DATABASE_URL)


def implied_prob_american(price):
    """Convert American odds to implied probability."""
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)


def kelly_stake(p_model, odds_american):
    """Fractional Kelly stake as a fraction of bankroll."""
    if odds_american is None or p_model is None:
        return None
    b = (odds_american / 100) if odds_american > 0 else (100 / -odds_american)
    q = 1 - p_model
    f = (b * p_model - q) / b
    return round(min(max(f * KELLY_FRACTION, 0), MAX_STAKE_PCT), 4)


def confidence_label(edge: float) -> str:
    if edge >= HIGH_CONF_EDGE:
        return "HIGH"
    elif edge >= MED_CONF_EDGE:
        return "MEDIUM"
    return "LOW"


# ── Player Prop Edge Engine ───────────────────────────────────────────────────

def compute_prop_edges():
    """
    For each row in wnba_player_game_features with a matching wnba_player_props
    entry for today, compute:
      - model_mean (adjusted for minutes uncertainty + fatigue)
      - p_over / p_under via Poisson CDF
      - edge_over / edge_under vs implied odds
      - card_decision, confidence, staking_pct
    Writes results into wnba_model_predictions.

    Quality gates (from wnba/config.py):
      - minutes_proj >= MIN_MINUTES_PROJ
      - games_played >= MIN_GAMES_PLAYED (join count from wnba_player_game_logs)
    """
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Pull today's features joined to latest props for each player + prop_type
    cur.execute("""
        SELECT
            f.game_id,
            f.player_id,
            f.player_name,
            f.minutes_proj,
            f.rest_days,
            f.back_to_back,
            pp.prop_type,
            pp.line,
            pp.over_odds,
            pp.under_odds,
            pp.bookmaker,
            -- per-minute rate selector
            CASE pp.prop_type
                WHEN 'points'   THEN f.points_per_min
                WHEN 'rebounds' THEN f.rebounds_per_min
                WHEN 'assists'  THEN f.assists_per_min
                WHEN 'pra'      THEN (f.points_per_min + f.rebounds_per_min + f.assists_per_min)
                WHEN 'threes'   THEN f.threes_per_min
                ELSE NULL
            END AS rate_per_min,
            -- games played this season (for quality gate)
            (
                SELECT COUNT(*)
                FROM wnba_player_game_logs pgl
                JOIN wnba_games g ON pgl.game_id = g.game_id
                WHERE pgl.player_id = f.player_id
                  AND g.season = (SELECT season FROM wnba_games WHERE game_id = f.game_id)
            ) AS games_played
        FROM wnba_player_game_features f
        JOIN wnba_player_props pp
          ON f.player_id = pp.player_id
         AND f.game_id   = pp.game_id
        WHERE f.date = CURRENT_DATE
          AND f.minutes_proj >= %(min_minutes)s
        ORDER BY f.player_id, pp.prop_type
    """, {"min_minutes": MIN_MINUTES_PROJ})

    rows = cur.fetchall()
    insert_cur = conn.cursor()
    processed = 0

    for row in rows:
        # Quality gate: games played
        if row["games_played"] < MIN_GAMES_PLAYED:
            log.debug(f"Skipping {row['player_name']} — only {row['games_played']} games played")
            continue

        rate = row["rate_per_min"]
        if not rate or not row["line"]:
            continue

        # Adjust minutes for uncertainty via sampling (vectorised)
        np.random.seed(0)
        adj_minutes = float(np.mean(np.clip(
            np.random.normal(row["minutes_proj"], 2.0, 50_000), 0, 40
        )))

        # Model mean with fatigue adjustments
        mu = adj_minutes * rate
        if row["back_to_back"]:
            mu *= 0.94
        if row["rest_days"] == 0:
            mu *= 0.96

        line    = row["line"]
        p_over  = float(1 - poisson.cdf(int(line), mu))
        p_under = float(poisson.cdf(int(line), mu))

        p_imp_over  = implied_prob_american(row["over_odds"])
        p_imp_under = implied_prob_american(row["under_odds"])

        edge_over  = round(p_over  - p_imp_over,  4) if p_imp_over  else None
        edge_under = round(p_under - p_imp_under, 4) if p_imp_under else None

        edges      = [e for e in [edge_over, edge_under] if e is not None]
        best_edge  = max(edges) if edges else 0.0

        if best_edge >= EDGE_THRESHOLD:
            card_decision = "CANDIDATE"
            conf          = confidence_label(best_edge)
            if edge_over and edge_over == best_edge:
                staking = kelly_stake(p_over, row["over_odds"])
            else:
                staking = kelly_stake(p_under, row["under_odds"])
        else:
            card_decision = "NO BET"
            conf          = None
            staking       = 0.0

        insert_cur.execute("""
            INSERT INTO wnba_model_predictions (
                game_id, player_id, player_name,
                market_type, prop_type,
                model_mean, line, over_odds, under_odds,
                p_over, p_under,
                edge_over, edge_under,
                card_decision, confidence, staking_pct,
                created_at
            ) VALUES (
                %(game_id)s, %(player_id)s, %(player_name)s,
                'player_prop', %(prop_type)s,
                %(model_mean)s, %(line)s, %(over_odds)s, %(under_odds)s,
                %(p_over)s, %(p_under)s,
                %(edge_over)s, %(edge_under)s,
                %(card_decision)s, %(confidence)s, %(staking_pct)s,
                NOW()
            )
            ON CONFLICT DO NOTHING
        """, {
            "game_id":      row["game_id"],
            "player_id":    row["player_id"],
            "player_name":  row["player_name"],
            "prop_type":    row["prop_type"],
            "model_mean":   round(mu, 3),
            "line":         line,
            "over_odds":    row["over_odds"],
            "under_odds":   row["under_odds"],
            "p_over":       round(p_over, 4),
            "p_under":      round(p_under, 4),
            "edge_over":    edge_over,
            "edge_under":   edge_under,
            "card_decision": card_decision,
            "confidence":   conf,
            "staking_pct":  staking,
        })
        processed += 1

    conn.commit()
    cur.close()
    insert_cur.close()
    conn.close()
    log.info(f"compute_prop_edges: processed {processed} rows")


# ── Game Win-Probability + Total Edge Engine ─────────────────────────────────

def compute_game_edges():
    """
    For each today's wnba_games entry joined to latest wnba_game_odds,
    compute Bradley-Terry win probabilities and total over/under edges.
    Writes into wnba_model_predictions with market_type='game'.
    """
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT
            g.game_id,
            g.home_team_id, g.away_team_id,
            ml.home_moneyline, ml.away_moneyline,
            tot.total_line, tot.total_over_odds, tot.total_under_odds
        FROM wnba_games g
        LEFT JOIN LATERAL (
            SELECT home_moneyline, away_moneyline
            FROM wnba_game_odds
            WHERE game_id = g.game_id AND market = 'moneyline'
            ORDER BY odds_ts DESC LIMIT 1
        ) ml ON TRUE
        LEFT JOIN LATERAL (
            SELECT total_line, total_over_odds, total_under_odds
            FROM wnba_game_odds
            WHERE game_id = g.game_id AND market = 'totals'
            ORDER BY odds_ts DESC LIMIT 1
        ) tot ON TRUE
        WHERE g.game_date = CURRENT_DATE
          AND g.status = 'SCHEDULED'
    """)

    rows = cur.fetchall()
    insert_cur = conn.cursor()
    max_s   = 250
    gamma   = BRADLEY_TERRY_GAMMA

    for row in rows:
        # Derive implied team scoring from moneyline (proxy for strength)
        # Real version should use off_rtg * pace / 100 from wnba_team_game_features
        p_imp_home = implied_prob_american(row["home_moneyline"])
        p_imp_away = implied_prob_american(row["away_moneyline"])
        if not p_imp_home or not p_imp_away:
            continue

        # Back-solve implied mu from Bradley-Terry
        # p_home = mu_h^gamma / (mu_h^gamma + mu_a^gamma)
        # For now use total_line / 2 as starting point + moneyline skew
        total_line = row["total_line"]
        if not total_line:
            continue

        mu_home = total_line * p_imp_home
        mu_away = total_line * p_imp_away

        p_home = mu_home**gamma / (mu_home**gamma + mu_away**gamma)
        p_away = 1 - p_home

        # Total distribution
        probs_h   = [float(poisson.pmf(k, mu_home)) for k in range(max_s+1)]
        probs_a   = [float(poisson.pmf(k, mu_away)) for k in range(max_s+1)]
        probs_tot = [0.0] * (2*max_s+2)
        for i in range(max_s+1):
            for j in range(max_s+1):
                probs_tot[i+j] += probs_h[i]*probs_a[j]

        p_over_tot  = float(sum(probs_tot[int(total_line)+1:]))
        p_under_tot = 1 - p_over_tot

        p_imp_over  = implied_prob_american(row["total_over_odds"])
        p_imp_under = implied_prob_american(row["total_under_odds"])

        edge_home  = round(p_home  - p_imp_home,  4) if p_imp_home  else None
        edge_away  = round(p_away  - p_imp_away,  4) if p_imp_away  else None
        edge_over  = round(p_over_tot  - p_imp_over,  4) if p_imp_over  else None
        edge_under = round(p_under_tot - p_imp_under, 4) if p_imp_under else None

        edges     = [e for e in [edge_home, edge_away, edge_over, edge_under] if e is not None]
        best_edge = max(edges) if edges else 0.0
        decision  = "CANDIDATE" if best_edge >= EDGE_THRESHOLD else "NO BET"

        insert_cur.execute("""
            INSERT INTO wnba_model_predictions (
                game_id, market_type, prop_type,
                model_mean_home, model_mean_away,
                p_home, p_away, p_over, p_under,
                edge_home, edge_away, edge_over, edge_under,
                home_odds, away_odds, line, over_odds, under_odds,
                card_decision, created_at
            ) VALUES (
                %(game_id)s, 'game', 'total',
                %(mu_home)s, %(mu_away)s,
                %(p_home)s, %(p_away)s, %(p_over)s, %(p_under)s,
                %(edge_home)s, %(edge_away)s, %(edge_over)s, %(edge_under)s,
                %(home_ml)s, %(away_ml)s,
                %(total_line)s, %(total_over)s, %(total_under)s,
                %(decision)s, NOW()
            )
            ON CONFLICT DO NOTHING
        """, {
            "game_id":   row["game_id"],
            "mu_home":   round(mu_home, 2),
            "mu_away":   round(mu_away, 2),
            "p_home":    round(p_home, 4),
            "p_away":    round(p_away, 4),
            "p_over":    round(p_over_tot, 4),
            "p_under":   round(p_under_tot, 4),
            "edge_home": edge_home,
            "edge_away": edge_away,
            "edge_over": edge_over,
            "edge_under":edge_under,
            "home_ml":   row["home_moneyline"],
            "away_ml":   row["away_moneyline"],
            "total_line":total_line,
            "total_over":row["total_over_odds"],
            "total_under":row["total_under_odds"],
            "decision":  decision,
        })

    conn.commit()
    cur.close()
    insert_cur.close()
    conn.close()
    log.info(f"compute_game_edges: processed {len(rows)} games")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    log.info("Running WNBA edge engines...")
    compute_game_edges()
    compute_prop_edges()
    log.info("Done.")
