import psycopg2
import psycopg2.extras
from nba.config import DATABASE_URL, EDGE_THRESHOLD, KELLY_FRACTION, MAX_STAKE_PCT
from datetime import datetime
import logging

log = logging.getLogger("betintel.nba.models.compute_nba_edges")

# ── Base thresholds ───────────────────────────────────────────────────────────
CONFIDENCE_FLOOR    = 0.55
FAVORITE_CLIFF_ODDS = -250
CANDIDATE_EDGE_FLOOR = 0.055   # mirrors MLB floor added Jun 6

# ── SERIES_UNDER_BIAS — NEW Jun 6 ────────────────────────────────────────────
# NBA Finals Game 3 signal: both G1 (200) and G2 (209) hit under their lines.
# When the last N consecutive games in a playoff series both go under,
# boost the under probability by SERIES_UNDER_BOOST for the next game.
# This captures the defensive adjustment / pace-down pattern that emerges
# in tight Finals matchups. Re-evaluate after series ends.
# G1 Under 211.5 ✅ (200 total), G2 Under 214.5 ✅ (209 total).
# Series average so far: 204.5 — well below posted lines.
SERIES_UNDER_BIAS_ENABLED  = True
SERIES_UNDER_CONSECUTIVE   = 2      # require this many consecutive game unders
SERIES_UNDER_BOOST         = 0.06   # +6% to p_under when bias fires
SERIES_UNDER_MAX_GAMES     = 6      # don't apply in Game 7 (small sample noise)

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

def _fetch_series_under_streak(cur, series_id, current_game_num):
    """
    Returns the number of consecutive under results ending before current_game_num.
    Query checks game_results for the series and counts back-to-back unders.
    Returns 0 if data unavailable or streak is broken.
    """
    cur.execute("""
        SELECT went_under
        FROM nba_game_results
        WHERE series_id = %s AND game_num < %s
        ORDER BY game_num DESC
        LIMIT %s
    """, (series_id, current_game_num, SERIES_UNDER_CONSECUTIVE))
    rows = cur.fetchall()
    if len(rows) < SERIES_UNDER_CONSECUTIVE:
        return 0
    streak = sum(1 for r in rows if r[0])
    return streak

def compute_nba_game_edges():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    today = datetime.utcnow().strftime("%Y-%m-%d")

    cur.execute("""
        SELECT mp.id, mp.game_id, mp.p_home_model, mp.p_away_model,
               mp.model_total,
               gc.home_team_id, gc.away_team_id,
               gc.series_id, gc.game_num,
               ms_ml.home_odds, ms_ml.away_odds,
               ms_tot.line AS total_line,
               ms_tot.over_odds, ms_tot.under_odds
        FROM nba_model_predictions mp
        JOIN nba_game_context gc ON mp.game_id = gc.game_id
        LEFT JOIN LATERAL (
            SELECT home_odds, away_odds FROM nba_market_snapshots
            WHERE game_id = mp.game_id AND market_type = 'h2h'
            ORDER BY snapshot_time DESC LIMIT 1
        ) ms_ml ON TRUE
        LEFT JOIN LATERAL (
            SELECT line, over_odds, under_odds FROM nba_market_snapshots
            WHERE game_id = mp.game_id AND market_type = 'totals'
            ORDER BY snapshot_time DESC LIMIT 1
        ) ms_tot ON TRUE
        WHERE mp.edges_computed IS NULL
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()

    for row in rows:
        p_home = row["p_home_model"]
        p_away = row["p_away_model"]
        model_total = row["model_total"]
        total_line  = row["total_line"]

        if not p_home or not p_away:
            continue

        # ── SERIES_UNDER_BIAS ─────────────────────────────────────────────────
        # Boost under probability when last N games in same series all went under.
        # Captures defensive adjustments and pace management in close series.
        series_under_triggered = False
        p_over_tot  = None
        p_under_tot = None

        if total_line and model_total:
            raw_over_prob  = max(0.0, min(1.0, 0.5 + (model_total - float(total_line)) / 20.0))
            raw_under_prob = 1.0 - raw_over_prob

            if (
                SERIES_UNDER_BIAS_ENABLED and
                row["series_id"] and
                row["game_num"] and
                row["game_num"] <= SERIES_UNDER_MAX_GAMES
            ):
                streak = _fetch_series_under_streak(cur, row["series_id"], row["game_num"])
                if streak >= SERIES_UNDER_CONSECUTIVE:
                    raw_under_prob = min(raw_under_prob + SERIES_UNDER_BOOST, 0.99)
                    raw_over_prob  = 1.0 - raw_under_prob
                    series_under_triggered = True
                    log.info(
                        f"SERIES_UNDER_BIAS: game_id={row['game_id']} series={row['series_id']} "
                        f"game_num={row['game_num']} streak={streak} "
                        f"-> p_under boosted to {raw_under_prob:.3f}"
                    )

            p_over_tot  = raw_over_prob
            p_under_tot = raw_under_prob

        p_imp_home  = implied_prob_american(row["home_odds"])
        p_imp_away  = implied_prob_american(row["away_odds"])
        p_imp_over  = implied_prob_american(row["over_odds"])
        p_imp_under = implied_prob_american(row["under_odds"])

        edge_home  = round(p_home  - p_imp_home,  4) if p_imp_home  else None
        edge_away  = round(p_away  - p_imp_away,  4) if p_imp_away  else None
        edge_over  = round(p_over_tot  - p_imp_over,  4) if p_imp_over  and p_over_tot  else None
        edge_under = round(p_under_tot - p_imp_under, 4) if p_imp_under and p_under_tot else None

        edges     = [e for e in [edge_home, edge_away, edge_over, edge_under] if e is not None]
        best_edge = max(edges) if edges else None

        winning_side = "home" if p_home >= p_away else "away"
        winning_conf = max(p_home, p_away)
        winning_odds = row["home_odds"] if winning_side == "home" else row["away_odds"]

        if winning_conf < CONFIDENCE_FLOOR:
            decision = "LEAN"
        elif winning_odds is not None and winning_odds <= FAVORITE_CLIFF_ODDS:
            decision = "LEAN"
            log.warning(f"NBA_FAVORITE_CLIFF: game_id={row['game_id']} odds={winning_odds}")
        elif best_edge and best_edge < CANDIDATE_EDGE_FLOOR:
            decision = "LEAN"
        else:
            decision = "CANDIDATE" if best_edge and best_edge >= CANDIDATE_EDGE_FLOOR else "NO BET"

        update_cur.execute("""
            INSERT INTO nba_model_edges
                (game_id, p_home, p_away, p_over, p_under,
                 edge_home, edge_away, edge_over, edge_under,
                 card_decision, series_under_bias, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (game_id) DO UPDATE SET
                p_home=EXCLUDED.p_home, p_away=EXCLUDED.p_away,
                p_over=EXCLUDED.p_over, p_under=EXCLUDED.p_under,
                edge_home=EXCLUDED.edge_home, edge_away=EXCLUDED.edge_away,
                edge_over=EXCLUDED.edge_over, edge_under=EXCLUDED.edge_under,
                card_decision=EXCLUDED.card_decision,
                series_under_bias=EXCLUDED.series_under_bias
        """, (
            row["game_id"], p_home, p_away, p_over_tot, p_under_tot,
            edge_home, edge_away, edge_over, edge_under,
            decision, series_under_triggered
        ))

        update_cur.execute("""
            UPDATE nba_model_predictions SET edges_computed=NOW() WHERE id=%s
        """, (row["id"],))

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"compute_nba_game_edges: processed {len(rows)} rows")
