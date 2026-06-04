"""compute_batter_edges.py

Computes edge, implied probability, and Kelly stake for hits and
total bases props. Mirrors compute_edges.py (K strikeout pattern).

For hits:        uses Poisson distribution
For total bases: uses Negative Binomial (higher variance, HR tail)

Both update model_predictions with p_over, p_under, edge_over,
edge_under, card_decision, staking_pct.
"""
import math
import psycopg2
import psycopg2.extras
from scipy.stats import poisson, nbinom
from mlb.config import DATABASE_URL, EDGE_THRESHOLD, KELLY_FRACTION, MAX_STAKE_PCT
from datetime import datetime
import logging

log = logging.getLogger("betintel.models.batter_edges")

NB_DISPERSION = 0.65   # matches predict_tb.py

def get_db():
    return psycopg2.connect(DATABASE_URL)

def implied_prob(price: int) -> float | None:
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)

def kelly_stake(p_model: float, odds: int) -> float | None:
    if odds is None or p_model is None:
        return None
    b = (odds / 100) if odds > 0 else (100 / -odds)
    q = 1 - p_model
    f = (b * p_model - q) / b
    return round(min(max(f * KELLY_FRACTION, 0), MAX_STAKE_PCT), 4)

def _p_over_poisson(lam: float, line: float) -> float:
    return float(1 - poisson.cdf(math.floor(line), lam))

def _p_over_nb(mu: float, line: float) -> float:
    r = NB_DISPERSION
    p = r / (r + mu)
    return float(1 - nbinom.cdf(math.floor(line), r, p))

def _compute_prop_edges(prop_type: str):
    conn = get_db()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT mp.id, mp.game_id, mp.player_id, mp.player_name,
               mp.model_mean,
               ms.line, ms.over_odds, ms.under_odds
        FROM model_predictions mp
        JOIN market_snapshots ms
          ON mp.game_id  = ms.game_id
         AND mp.player_id = ms.player_id
         AND ms.market_type = 'player_prop'
         AND ms.prop_type   = %s
        WHERE mp.market_type = 'player_prop'
          AND mp.prop_type   = %s
          AND mp.p_over IS NULL
          AND DATE(mp.created_at) = CURRENT_DATE
        ORDER BY mp.player_id
    """, (prop_type, prop_type))
    rows = cur.fetchall()

    update_cur = conn.cursor()

    for row in rows:
        lam  = row["model_mean"]
        line = row["line"]
        if not lam or not line:
            continue

        if prop_type == "hits":
            p_over  = _p_over_poisson(lam, line)
        else:   # total_bases — NB
            p_over  = _p_over_nb(lam, line)

        p_under      = 1 - p_over
        p_imp_over   = implied_prob(row["over_odds"])
        p_imp_under  = implied_prob(row["under_odds"])
        edge_over    = round(p_over  - p_imp_over,  4) if p_imp_over  else None
        edge_under   = round(p_under - p_imp_under, 4) if p_imp_under else None
        edges        = [e for e in [edge_over, edge_under] if e is not None]
        best_edge    = max(edges) if edges else None
        decision     = "CANDIDATE" if best_edge and best_edge >= EDGE_THRESHOLD else "NO BET"

        staking = None
        if decision == "CANDIDATE":
            if edge_over and edge_over == best_edge:
                staking = kelly_stake(p_over,  row["over_odds"])
            else:
                staking = kelly_stake(p_under, row["under_odds"])

        update_cur.execute("""
            UPDATE model_predictions SET
                player_name = %s,
                line        = %s,
                over_odds   = %s,
                under_odds  = %s,
                p_over      = %s,
                p_under     = %s,
                edge_over   = %s,
                edge_under  = %s,
                card_decision = %s,
                staking_pct   = %s
            WHERE id = %s
        """, (
            row["player_name"],
            line, row["over_odds"], row["under_odds"],
            p_over, p_under, edge_over, edge_under,
            decision, staking,
            row["id"]
        ))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_batter_edges ({prop_type}): processed {len(rows)} rows")

def compute_hits_edges():
    _compute_prop_edges("hits")

def compute_tb_edges():
    _compute_prop_edges("total_bases")
