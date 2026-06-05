"""
team_momentum.py — Ingests last-5 run differential per team into team_momentum table.
Scheduled daily before compute_run_edges() runs.

Source: game_results table (already populated by existing ingestion pipeline).
"""

import psycopg2
import psycopg2.extras
from mlb.config import DATABASE_URL
from datetime import datetime, timedelta
import logging

log = logging.getLogger("betintel.ingestion.team_momentum")

def compute_and_store_momentum(target_date: str = None):
    """
    For each team, computes the average run differential over the last 5 games
    prior to target_date and upserts into team_momentum.
    """
    if not target_date:
        target_date = datetime.utcnow().strftime("%Y-%m-%d")

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Pull all distinct teams active in the last 30 days
    cur.execute("""
        SELECT DISTINCT home_team_id AS team_id FROM game_results
        WHERE game_date >= %s::date - INTERVAL '30 days'
        UNION
        SELECT DISTINCT away_team_id FROM game_results
        WHERE game_date >= %s::date - INTERVAL '30 days'
    """, (target_date, target_date))
    teams = [r["team_id"] for r in cur.fetchall()]

    write_cur = conn.cursor()
    inserted = 0

    for team_id in teams:
        # Last 5 completed games for this team
        cur.execute("""
            SELECT
                CASE WHEN home_team_id = %s THEN home_runs - away_runs
                     ELSE away_runs - home_runs END AS run_diff
            FROM game_results
            WHERE (home_team_id = %s OR away_team_id = %s)
              AND game_date < %s
              AND status = 'final'
            ORDER BY game_date DESC
            LIMIT 5
        """, (team_id, team_id, team_id, target_date))
        rows = cur.fetchall()
        if not rows:
            continue

        run_diffs = [float(r["run_diff"]) for r in rows]
        avg_diff  = round(sum(run_diffs) / len(run_diffs), 2)

        write_cur.execute("""
            INSERT INTO team_momentum (team_id, date, run_diff_last5, games_played)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (team_id, date) DO UPDATE
            SET run_diff_last5 = EXCLUDED.run_diff_last5,
                games_played   = EXCLUDED.games_played
        """, (team_id, target_date, avg_diff, len(run_diffs)))
        inserted += 1

    conn.commit()
    cur.close()
    write_cur.close()
    conn.close()
    log.info(f"team_momentum: upserted {inserted} rows for {target_date}")

if __name__ == "__main__":
    compute_and_store_momentum()
