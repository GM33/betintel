import psycopg2
from datetime import datetime, date, timedelta
from wnba.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.wnba.ingestion.stats")

WNBA_LEAGUE_ID = "10"   # nba_api league_id for WNBA


def get_db():
    return psycopg2.connect(DATABASE_URL)


# ── Team + Player seeding ─────────────────────────────────────────────────────

def seed_teams():
    """
    Seed wnba_teams from nba_api.stats.static.teams.
    Uses league_id=10 filter via py_ball or direct stats.nba.com call.
    """
    try:
        from nba_api.stats.static import teams as nba_teams
        all_teams = nba_api_wnba_teams()
    except Exception as e:
        log.error(f"seed_teams failed: {e}")
        return

    conn = get_db()
    cur  = conn.cursor()
    for t in all_teams:
        cur.execute("""
            INSERT INTO wnba_teams (
                team_id, city, name, full_name, abbreviation, updated_at
            ) VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (team_id) DO UPDATE
                SET full_name    = EXCLUDED.full_name,
                    abbreviation = EXCLUDED.abbreviation,
                    updated_at   = NOW()
        """, (str(t["id"]), t["city"], t["nickname"], t["full_name"], t["abbreviation"]))
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"seed_teams: {len(all_teams)} teams upserted")


def seed_players(season: str = "2026"):
    """
    Seed wnba_players from CommonAllPlayers with league_id=10.
    """
    try:
        from nba_api.stats.endpoints import commonallplayers
        resp = commonallplayers.CommonAllPlayers(
            league_id=WNBA_LEAGUE_ID,
            season=season,
            is_only_current_season=1,
            timeout=30
        )
        players = resp.get_data_frames()[0]
    except Exception as e:
        log.error(f"seed_players failed: {e}")
        return

    conn = get_db()
    cur  = conn.cursor()
    count = 0
    for _, row in players.iterrows():
        cur.execute("""
            INSERT INTO wnba_players (
                player_id, team_id, first_name, last_name, full_name,
                is_active, updated_at
            ) VALUES (%s, %s, %s, %s, %s, TRUE, NOW())
            ON CONFLICT (player_id) DO UPDATE
                SET team_id    = EXCLUDED.team_id,
                    full_name  = EXCLUDED.full_name,
                    is_active  = TRUE,
                    updated_at = NOW()
        """, (
            int(row["PERSON_ID"]),
            str(row["TEAM_ID"]) if row["TEAM_ID"] else None,
            row["DISPLAY_FIRST_LAST"].split(" ")[0],
            " ".join(row["DISPLAY_FIRST_LAST"].split(" ")[1:]),
            row["DISPLAY_FIRST_LAST"],
        ))
        count += 1
    conn.commit()
    cur.close()
    conn.close()
    log.info(f"seed_players: {count} players upserted")


# ── Player game logs ──────────────────────────────────────────────────────────

def ingest_player_logs(season: str = "2026", days_back: int = 3):
    """
    Pull per-player game logs for the last N days and insert into:
      - wnba_player_game_logs
      - wnba_player_game_features  (per-min rates + rest days)
    Uses nba_api PlayerGameLog with league_id=10.
    """
    try:
        from nba_api.stats.endpoints import playergamelog
        from nba_api.stats.static import players as nba_players
    except ImportError:
        log.error("nba_api not installed. Run: pip install nba_api")
        return

    conn = get_db()
    cur  = conn.cursor()

    # Pull all active WNBA players from our DB
    cur.execute("SELECT player_id FROM wnba_players WHERE is_active = TRUE")
    player_ids = [r[0] for r in cur.fetchall()]
    cutoff     = date.today() - timedelta(days=days_back)
    inserted   = 0

    for pid in player_ids:
        try:
            gl = playergamelog.PlayerGameLog(
                player_id=pid,
                season=season,
                league_id=WNBA_LEAGUE_ID,
                timeout=30
            )
            df = gl.get_data_frames()[0]
        except Exception as e:
            log.debug(f"PlayerGameLog failed for {pid}: {e}")
            continue

        for _, row in df.iterrows():
            game_date = datetime.strptime(row["GAME_DATE"], "%b %d, %Y").date()
            if game_date < cutoff:
                continue

            game_id = str(row["Game_ID"])
            minutes = _parse_minutes(str(row["MIN"]))
            pts     = int(row["PTS"])
            reb     = int(row["REB"])
            ast     = int(row["AST"])
            stl     = int(row["STL"])
            blk     = int(row["BLK"])
            tov     = int(row["TOV"])
            pf      = int(row["PF"])
            fg3m    = int(row["FG3M"])
            fg3a    = int(row["FG3A"])
            fgm     = int(row["FGM"])
            fga     = int(row["FGA"])
            ftm     = int(row["FTM"])
            fta     = int(row["FTA"])
            pm      = int(row.get("+/-", 0))
            team_id = str(row["TEAM_ID"])

            # Upsert game log
            cur.execute("""
                INSERT INTO wnba_player_game_logs (
                    game_id, player_id, team_id,
                    minutes, points, rebounds, assists,
                    steals, blocks, turnovers, fouls,
                    three_made, three_att,
                    field_goals_made, field_goals_att,
                    free_throws_made, free_throws_att,
                    plus_minus, created_at
                ) VALUES (
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()
                )
                ON CONFLICT DO NOTHING
            """, (
                game_id, pid, team_id,
                minutes, pts, reb, ast,
                stl, blk, tov, pf,
                fg3m, fg3a, fgm, fga, ftm, fta, pm
            ))

            # Compute per-minute rates for feature table
            if minutes and minutes > 0:
                pts_pm = pts / minutes
                reb_pm = reb / minutes
                ast_pm = ast / minutes
                fg3_pm = fg3m / minutes
            else:
                pts_pm = reb_pm = ast_pm = fg3_pm = None

            cur.execute("""
                INSERT INTO wnba_player_game_features (
                    game_id, date, player_id, team_id,
                    minutes_proj,
                    points_per_min, rebounds_per_min,
                    assists_per_min, threes_per_min,
                    rest_days, created_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
                ON CONFLICT DO NOTHING
            """, (
                game_id, game_date, pid, team_id,
                minutes,                   # historical = actual minutes
                pts_pm, reb_pm, ast_pm, fg3_pm,
                None,                      # rest_days computed in feature enrichment step
                ))
            inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"ingest_player_logs: {inserted} rows across {len(player_ids)} players")


# ── Team game logs ────────────────────────────────────────────────────────────

def ingest_team_logs(season: str = "2026", days_back: int = 3):
    """
    Pull team-level box scores for the last N days.
    Writes into wnba_team_game_logs.
    """
    try:
        from nba_api.stats.endpoints import teamgamelog
    except ImportError:
        log.error("nba_api not installed.")
        return

    conn = get_db()
    cur  = conn.cursor()
    cur.execute("SELECT team_id FROM wnba_teams")
    team_ids = [r[0] for r in cur.fetchall()]
    cutoff   = date.today() - timedelta(days=days_back)
    inserted = 0

    for tid in team_ids:
        try:
            tgl = teamgamelog.TeamGameLog(
                team_id=tid,
                season=season,
                league_id=WNBA_LEAGUE_ID,
                timeout=30
            )
            df = tgl.get_data_frames()[0]
        except Exception as e:
            log.debug(f"TeamGameLog failed for {tid}: {e}")
            continue

        for _, row in df.iterrows():
            game_date = datetime.strptime(row["GAME_DATE"], "%b %d, %Y").date()
            if game_date < cutoff:
                continue

            game_id = str(row["Game_ID"])
            is_home = "vs." in str(row["MATCHUP"])
            pts     = int(row["PTS"])

            cur.execute("""
                INSERT INTO wnba_team_game_logs (
                    game_id, team_id, is_home, points,
                    field_goals_made, field_goals_att,
                    three_made, three_att,
                    free_throws_made, free_throws_att,
                    offensive_reb, defensive_reb,
                    assists, steals, blocks, turnovers, fouls,
                    created_at
                ) VALUES (
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()
                )
                ON CONFLICT DO NOTHING
            """, (
                game_id, tid, is_home, pts,
                row.get("FGM"), row.get("FGA"),
                row.get("FG3M"), row.get("FG3A"),
                row.get("FTM"), row.get("FTA"),
                row.get("OREB"), row.get("DREB"),
                row.get("AST"), row.get("STL"),
                row.get("BLK"), row.get("TOV"), row.get("PF"),
            ))
            inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"ingest_team_logs: {inserted} rows across {len(team_ids)} teams")


# ── Utilities ─────────────────────────────────────────────────────────────────

def _parse_minutes(min_str: str) -> float | None:
    """Convert 'MM:SS' string to float minutes."""
    try:
        parts = min_str.split(":")
        return float(parts[0]) + float(parts[1]) / 60 if len(parts) == 2 else float(min_str)
    except Exception:
        return None


def nba_api_wnba_teams() -> list[dict]:
    """Return WNBA teams from nba_api static data."""
    from nba_api.stats.static import teams
    return [t for t in teams.get_teams() if t.get("league_id") == WNBA_LEAGUE_ID
            or t.get("abbreviation") in {
                "ATL", "CHI", "CON", "DAL", "GS", "IND", "LA",
                "LV", "MIN", "NY", "PHX", "POR", "SEA", "WSH"
            }]


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    log.info("Seeding WNBA teams and players...")
    seed_teams()
    seed_players()
    log.info("Ingesting recent game logs...")
    ingest_team_logs()
    ingest_player_logs()
    log.info("Done.")
