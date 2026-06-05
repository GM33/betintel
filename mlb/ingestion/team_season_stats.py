"""
team_season_stats.py — Ingests season-level team stats daily.
Populates:
  - season_run_diff: cumulative season run differential
  - wrc_plus_rank:   team wRC+ offensive rank (1 = best in MLB)

Data sources:
  - season_run_diff: computed from game_results table directly
  - wrc_plus_rank:   fetched from FanGraphs team wRC+ leaderboard

Scheduled: daily at 06:00 UTC, before compute_run_edges() runs.
Added: June 5, 2026 — supports VALUE_DOG rule in compute_edges.py
"""

import psycopg2
import psycopg2.extras
import requests
from mlb.config import DATABASE_URL
from datetime import datetime
import logging

log = logging.getLogger("betintel.ingestion.team_season_stats")

# FanGraphs team wRC+ leaderboard endpoint (public, no auth required)
FANGRAPHS_TEAM_WRC_URL = (
    "https://www.fangraphs.com/api/leaders/major-league/data"
    "?age=&pos=all&stats=bat&lg=all&qual=0&season={year}&season1={year}"
    "&ind=0&team=0%2Cts&rost=0&players=0&type=8&postseason="
    "&sortdir=default&sortstat=wRC%2B"
)

def _fetch_wrc_plus_rankings(year: int) -> dict:
    """
    Fetches FanGraphs team wRC+ leaderboard and returns
    {team_name: rank} dict ordered best-to-worst (rank 1 = highest wRC+).
    Falls back to empty dict on network failure — ingestion continues
    without wrc_plus_rank update rather than blocking the pipeline.
    """
    url = FANGRAPHS_TEAM_WRC_URL.format(year=year)
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        rankings = {}
        for rank, row in enumerate(data, start=1):
            team_name = row.get("TeamName") or row.get("Team")
            if team_name:
                rankings[team_name.strip()] = rank
        log.info(f"FanGraphs wRC+ rankings fetched: {len(rankings)} teams for {year}")
        return rankings
    except Exception as e:
        log.warning(f"FanGraphs wRC+ fetch failed: {e} — wrc_plus_rank will not update today")
        return {}

def compute_and_store_season_stats(target_date: str = None):
    """
    For each team, computes and upserts into team_season_stats:
      - season_run_diff: sum of (team_runs - opp_runs) across all completed
                         games in the current season up to target_date
      - wrc_plus_rank:   rank from FanGraphs wRC+ leaderboard (1 = best)
    """
    if not target_date:
        target_date = datetime.utcnow().strftime("%Y-%m-%d")

    year = int(target_date[:4])
    season_start = f"{year}-03-01"

    wrc_rankings = _fetch_wrc_plus_rankings(year)

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Pull all teams active this season
    cur.execute("""
        SELECT DISTINCT home_team_id AS team_id, t.team_name
        FROM game_results gr
        JOIN teams t ON t.team_id = gr.home_team_id
        WHERE gr.game_date >= %s AND gr.game_date < %s
        UNION
        SELECT DISTINCT away_team_id, t.team_name
        FROM game_results gr
        JOIN teams t ON t.team_id = gr.away_team_id
        WHERE gr.game_date >= %s AND gr.game_date < %s
    """, (season_start, target_date, season_start, target_date))
    teams = cur.fetchall()

    write_cur = conn.cursor()
    upserted = 0

    for team in teams:
        team_id   = team["team_id"]
        team_name = team["team_name"]

        # Season run differential: home games + road games
        cur.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN home_team_id = %s THEN home_runs - away_runs
                                  ELSE away_runs - home_runs END), 0) AS season_rd
            FROM game_results
            WHERE (home_team_id = %s OR away_team_id = %s)
              AND game_date >= %s
              AND game_date < %s
              AND status = 'final'
        """, (team_id, team_id, team_id, season_start, target_date))
        row = cur.fetchone()
        season_rd = float(row["season_rd"]) if row else 0.0

        # wRC+ rank: match team_name to FanGraphs leaderboard
        wrc_rank = wrc_rankings.get(team_name)
        if wrc_rank is None:
            # Fuzzy fallback: check if team_name is a substring of any FG key
            for fg_name, rank in wrc_rankings.items():
                if team_name in fg_name or fg_name in team_name:
                    wrc_rank = rank
                    break

        write_cur.execute("""
            INSERT INTO team_season_stats (team_id, season, season_run_diff, wrc_plus_rank)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (team_id, season) DO UPDATE
            SET season_run_diff = EXCLUDED.season_run_diff,
                wrc_plus_rank   = COALESCE(EXCLUDED.wrc_plus_rank, team_season_stats.wrc_plus_rank)
        """, (team_id, year, season_rd, wrc_rank))
        upserted += 1

    conn.commit()
    cur.close()
    write_cur.close()
    conn.close()
    log.info(
        f"team_season_stats: upserted {upserted} teams for {year} "
        f"(run_diff + wrc_plus_rank). wRC+ coverage: {len(wrc_rankings)} teams."
    )

if __name__ == "__main__":
    compute_and_store_season_stats()
