"""Team offensive stats ingestion.

Populates team_offense_stats.slugging_pct (and supporting columns)
for every team, using the MLB Stats API season hitting stats.

Run order: after fetch_schedule, before build_game_features.
Scheduled at 9:15 AM ET daily (after schedule at 9:00, before lineups at 13:10).
"""
import logging
import requests
import psycopg2
import psycopg2.extras
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL

log = logging.getLogger("betintel.ingestion.team_offense")
ET = ZoneInfo("America/New_York")

MLB_TEAMS_URL = MLB_BASE + "/teams?sportId=1"
MLB_TEAM_STATS_URL = (
    MLB_BASE
    + "/teams/{team_id}/stats?stats=season&group=hitting&season={season}&sportId=1"
)
# Rolling last-N-games split for recent SLG (more predictive than season avg)
MLB_TEAM_STATS_LAST15 = (
    MLB_BASE
    + "/teams/{team_id}/stats?stats=lastXGames&group=hitting&season={season}&sportId=1&limit=15"
)


def get_db():
    return psycopg2.connect(DATABASE_URL)


def _safe_float(val) -> float | None:
    try:
        return round(float(val), 4) if val not in (None, "", "null", ".---") else None
    except (TypeError, ValueError):
        return None


def _parse_hitting_splits(splits: list) -> dict:
    if not splits:
        return {}
    stat = splits[0].get("stat", {})
    return {
        "slugging_pct":  _safe_float(stat.get("slg")),
        "obp":           _safe_float(stat.get("obp")),
        "ops":           _safe_float(stat.get("ops")),
        "batting_avg":   _safe_float(stat.get("avg")),
        "runs_per_game": _safe_float(stat.get("runsBatted")),  # R scored not RBI — use if avail
        "hr":            _safe_float(stat.get("homeRuns")),
        "wrc_plus":      None,  # not in MLB API — leave for Fangraphs v2
    }


def fetch_team_offense_stats(date_str: str | None = None):
    """Pull season + last-15-game hitting stats for all 30 teams.

    Writes both season_slg and recent_slg so build_game_features can use
    the rolling window (more predictive) while still storing season baseline.

    Args:
        date_str: YYYY-MM-DD context date.  Defaults to today ET.
    """
    today = date_str or datetime.now(ET).strftime("%Y-%m-%d")
    season = int(today[:4])

    # 1. Get all 30 team IDs
    try:
        resp = requests.get(MLB_TEAMS_URL, timeout=10)
        resp.raise_for_status()
        teams = resp.json().get("teams", [])
    except Exception as e:
        log.error(f"fetch_team_offense_stats: teams list failed: {e}")
        return

    conn = get_db()
    cur = conn.cursor()
    upserted = 0

    for team in teams:
        team_id   = team["id"]
        team_name = team.get("name", str(team_id))
        abbrev    = team.get("abbreviation", "")

        # --- Season stats (baseline) ---
        season_stats: dict = {}
        try:
            r = requests.get(
                MLB_TEAM_STATS_URL.format(team_id=team_id, season=season),
                timeout=10,
            )
            r.raise_for_status()
            season_stats = _parse_hitting_splits(r.json().get("stats", [{}])[0].get("splits", []))
        except Exception as e:
            log.warning(f"Season stats miss for {team_name}: {e}")

        # --- Last-15-game rolling stats (preferred for slg_delta) ---
        recent_stats: dict = {}
        try:
            r2 = requests.get(
                MLB_TEAM_STATS_LAST15.format(team_id=team_id, season=season),
                timeout=10,
            )
            r2.raise_for_status()
            recent_stats = _parse_hitting_splits(r2.json().get("stats", [{}])[0].get("splits", []))
        except Exception as e:
            log.debug(f"Last-15 miss for {team_name} — using season fallback: {e}")
            recent_stats = season_stats  # graceful fallback

        slg_season = season_stats.get("slugging_pct")
        slg_recent = recent_stats.get("slugging_pct") or slg_season

        if slg_season is None and slg_recent is None:
            log.warning(f"No SLG data at all for {team_name} ({team_id}) — skipping")
            continue

        try:
            cur.execute("""
                INSERT INTO team_offense_stats (
                    team_id, team_name, team_abbrev, season,
                    slugging_pct,
                    slugging_pct_recent,
                    obp, ops, batting_avg,
                    hr_season, wrc_plus,
                    last_updated
                ) VALUES (%s,%s,%s,%s, %s,%s, %s,%s,%s, %s,%s, %s)
                ON CONFLICT (team_id, season) DO UPDATE SET
                    team_name           = EXCLUDED.team_name,
                    team_abbrev         = EXCLUDED.team_abbrev,
                    slugging_pct        = EXCLUDED.slugging_pct,
                    slugging_pct_recent = EXCLUDED.slugging_pct_recent,
                    obp                 = EXCLUDED.obp,
                    ops                 = EXCLUDED.ops,
                    batting_avg         = EXCLUDED.batting_avg,
                    hr_season           = EXCLUDED.hr_season,
                    wrc_plus            = EXCLUDED.wrc_plus,
                    last_updated        = EXCLUDED.last_updated
            """, (
                team_id, team_name, abbrev, season,
                slg_season, slg_recent,
                season_stats.get("obp"),
                season_stats.get("ops"),
                season_stats.get("batting_avg"),
                season_stats.get("hr"),
                None,  # wrc_plus — Fangraphs v2
                datetime.utcnow(),
            ))
            upserted += 1
        except Exception as e:
            log.error(f"team_offense_stats upsert failed for {team_name}: {e}")

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_team_offense_stats: upserted {upserted}/{len(teams)} teams for {today}")
