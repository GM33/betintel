"""Statcast advanced pitcher stats ingestion.

Populates pitcher_stats.era, pitcher_stats.xfip, pitcher_stats.fip
for every starting pitcher confirmed on today's schedule.

Data source: Baseball Savant leaderboard CSV endpoint (no auth required).
Fallback:    MLB Stats API season pitching stats (ERA only).

Run order: after fetch_lineups, before build_game_features.
"""
import io
import csv
import logging
import requests
import psycopg2
import psycopg2.extras
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL

log = logging.getLogger("betintel.ingestion.pitcher_advanced")
ET = ZoneInfo("America/New_York")

# Baseball Savant season leaderboard — returns CSV with era, xfip, fip, xera
# player_type=starter filters to SPs; min_pitches keeps relievers out
SAVANT_URL = (
    "https://baseballsavant.mlb.com/leaderboard/expected_statistics"
    "?type=pitcher&year={season}&position=SP&team=&min=20&csv=true"
)

# MLB Stats API hydrated pitching for a single player (ERA fallback)
MLB_PLAYER_STATS = MLB_BASE + "/people/{player_id}/stats?stats=season&group=pitching&season={season}&sportId=1"


def get_db():
    return psycopg2.connect(DATABASE_URL)


def _season() -> int:
    return datetime.now(ET).year


def _fetch_savant_leaderboard(season: int) -> dict[int, dict]:
    """Return {mlb_player_id: {era, xfip, fip, xera, ...}} from Savant CSV."""
    url = SAVANT_URL.format(season=season)
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        log.warning(f"Savant leaderboard fetch failed: {e}")
        return {}

    reader = csv.DictReader(io.StringIO(resp.text))
    result = {}
    for row in reader:
        try:
            pid = int(row.get("player_id") or row.get("mlb_id") or 0)
            if not pid:
                continue
            result[pid] = {
                "era":  _safe_float(row.get("p_era") or row.get("era")),
                "xera": _safe_float(row.get("xera") or row.get("est_era")),
                "fip":  _safe_float(row.get("fip")),
                "xfip": _safe_float(row.get("xfip")),
                "k_pct":  _safe_float(row.get("k_percent")),
                "bb_pct": _safe_float(row.get("bb_percent")),
                "ip":     _safe_float(row.get("p_formatted_ip") or row.get("ip")),
            }
        except Exception:
            continue
    log.info(f"Savant leaderboard: {len(result)} pitchers loaded for {season}")
    return result


def _fetch_mlb_era(player_id: int, season: int) -> float | None:
    """Fallback: pull ERA from MLB Stats API for a single player."""
    try:
        resp = requests.get(
            MLB_PLAYER_STATS.format(player_id=player_id, season=season),
            timeout=10,
        )
        resp.raise_for_status()
        splits = resp.json().get("stats", [{}])[0].get("splits", [])
        if splits:
            return _safe_float(splits[0].get("stat", {}).get("era"))
    except Exception as e:
        log.debug(f"MLB ERA fallback failed for player {player_id}: {e}")
    return None


def _safe_float(val) -> float | None:
    try:
        return round(float(val), 2) if val not in (None, "", "null", "--") else None
    except (TypeError, ValueError):
        return None


def _get_todays_sp_ids(conn, today: str) -> list[dict]:
    """Return confirmed SPs for today's games from game_run_data."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT DISTINCT
            home_pitcher_id AS player_id,
            home_pitcher_name AS player_name
        FROM game_run_data
        WHERE date = %s AND home_pitcher_id IS NOT NULL
        UNION
        SELECT DISTINCT
            away_pitcher_id,
            away_pitcher_name
        FROM game_run_data
        WHERE date = %s AND away_pitcher_id IS NOT NULL
    """, (today, today))
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def fetch_pitcher_advanced_stats(date_str: str | None = None):
    """Main entry point.  Pull Savant leaderboard, upsert into pitcher_stats.

    Args:
        date_str: YYYY-MM-DD for the slate to cover.  Defaults to today ET.
    """
    today = date_str or datetime.now(ET).strftime("%Y-%m-%d")
    season = int(today[:4])

    savant = _fetch_savant_leaderboard(season)

    conn = get_db()
    sp_rows = _get_todays_sp_ids(conn, today)

    if not sp_rows:
        log.warning(f"fetch_pitcher_advanced_stats: no SPs found for {today}")
        conn.close()
        return

    cur = conn.cursor()
    upserted = 0
    for sp in sp_rows:
        pid = sp["player_id"]
        name = sp["player_name"]

        stats = savant.get(pid)

        if not stats:
            log.info(f"Savant miss for {name} ({pid}) — trying MLB API fallback")
            era_fallback = _fetch_mlb_era(pid, season)
            stats = {
                "era":  era_fallback,
                "xera": None,
                "fip":  None,
                "xfip": None,
                "k_pct": None,
                "bb_pct": None,
                "ip":  None,
            }

        try:
            cur.execute("""
                INSERT INTO pitcher_stats (
                    player_id, player_name, season,
                    era, xfip, fip, xera,
                    k_pct, bb_pct, ip,
                    last_updated
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (player_id, season) DO UPDATE SET
                    player_name  = EXCLUDED.player_name,
                    era          = EXCLUDED.era,
                    xfip         = EXCLUDED.xfip,
                    fip          = EXCLUDED.fip,
                    xera         = EXCLUDED.xera,
                    k_pct        = EXCLUDED.k_pct,
                    bb_pct       = EXCLUDED.bb_pct,
                    ip           = EXCLUDED.ip,
                    last_updated = EXCLUDED.last_updated
            """, (
                pid, name, season,
                stats["era"], stats["xfip"], stats["fip"], stats["xera"],
                stats["k_pct"], stats["bb_pct"], stats["ip"],
                datetime.utcnow(),
            ))
            upserted += 1
        except Exception as e:
            log.error(f"pitcher_stats upsert failed for {name} ({pid}): {e}")

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_pitcher_advanced_stats: upserted {upserted}/{len(sp_rows)} pitchers for {today}")
