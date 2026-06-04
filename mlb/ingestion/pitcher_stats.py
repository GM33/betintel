"""pitcher_stats.py

Fetches and upserts current-season advanced pitching stats for all active SPs.

Two data sources:
  1. MLB StatsAPI — ERA, IP, K/9, BB/9, HR/9, WHIP, GB% (free, official)
  2. Baseball Savant expected_statistics CSV — xERA, xFIP, FIP, SwStr%, CSW%, K%, BB%
     URL: https://baseballsavant.mlb.com/leaderboard/expected_statistics
          ?type=pitcher&year={season}&position=1&min=10&csv=true

Runs daily as startup step 2.5 (after lineups, before odds).
Upserts on (pitcher_id, season) so it's always idempotent.
"""
import io
import requests
import psycopg2
import psycopg2.extras
import csv
from datetime import datetime
from zoneinfo import ZoneInfo
from mlb.config import MLB_BASE, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.pitcher_stats")
ET  = ZoneInfo("America/New_York")

# Baseball Savant expected stats CSV endpoint
SAVANT_XSTATS_URL = (
    "https://baseballsavant.mlb.com/leaderboard/expected_statistics"
    "?type=pitcher&year={season}&position=1&min=10&csv=true"
)

# Baseball Savant Statcast leaderboard for SwStr%, CSW%, K%, BB%
SAVANT_PITCH_URL = (
    "https://baseballsavant.mlb.com/leaderboard/statcast"
    "?type=pitcher&year={season}&position=1&min=10&csv=true"
)

def get_db():
    return psycopg2.connect(DATABASE_URL)

# ── Source 1: MLB StatsAPI ──────────────────────────────────────────────────
def _fetch_mlb_era_stats(season: int) -> dict:
    """Returns {pitcher_id: {era, ip, k_per9, bb_per9, hr_per9, whip, full_name, team_id}}"""
    records = {}
    try:
        # Pull all active SP rosters
        teams_resp = requests.get(
            f"{MLB_BASE}/teams",
            params={"sportId": 1},
            timeout=10
        )
        teams_resp.raise_for_status()
        team_ids = [t["id"] for t in teams_resp.json().get("teams", [])]

        for team_id in team_ids:
            try:
                resp = requests.get(
                    f"{MLB_BASE}/teams/{team_id}/roster",
                    params={
                        "rosterType": "active",
                        "hydrate": f"stats(group=pitching,type=season,season={season}),person"
                    },
                    timeout=10
                )
                resp.raise_for_status()
                for player in resp.json().get("roster", []):
                    pos = player.get("position", {}).get("abbreviation", "")
                    if pos != "SP":
                        continue
                    person = player.get("person", {})
                    pid = person.get("id")
                    if not pid:
                        continue
                    stat_groups = person.get("stats", [])
                    for sg in stat_groups:
                        splits = sg.get("splits", [])
                        if not splits:
                            continue
                        s = splits[0].get("stat", {})
                        ip_raw = s.get("inningsPitched", "0.0")
                        parts  = str(ip_raw).split(".")
                        ip = int(parts[0]) + (int(parts[1]) / 3 if len(parts) > 1 and parts[1] else 0)
                        records[pid] = {
                            "pitcher_id": pid,
                            "full_name":  person.get("fullName"),
                            "team_id":    team_id,
                            "p_era":      _safe_float(s.get("era")),
                            "p_ip":       ip,
                            "p_k_per_9":  _safe_float(s.get("strikeoutsPer9Inn")),
                            "p_bb_per_9": _safe_float(s.get("walksPer9Inn")),
                            "p_hr_per_9": _safe_float(s.get("homeRunsPer9")),
                            "p_whip":     _safe_float(s.get("whip")),
                        }
            except Exception as e:
                log.warning(f"_fetch_mlb_era_stats: team {team_id}: {e}")
    except Exception as e:
        log.error(f"_fetch_mlb_era_stats: {e}")
    return records

# ── Source 2: Baseball Savant CSV ───────────────────────────────────────────────
CSV_FIELD_MAP = {
    # Savant expected_statistics columns → our field names
    "xera":        "p_xera",
    "xfip":        "p_xfip",
    "fip":         "p_fip",
    "p_swinging_strike": "p_swstr_rate",
    "csw_rate":    "p_csw_rate",
    "k_percent":   "p_k_rate",
    "bb_percent":  "p_bb_rate",
    # player_id column name in Savant CSV
    "player_id":   "savant_player_id",
    "mlb_id":      "savant_player_id",  # fallback column name variant
}

def _fetch_savant_xstats(season: int) -> dict:
    """Returns {pitcher_id (int): {p_xera, p_xfip, p_fip, p_swstr_rate, p_csw_rate, p_k_rate, p_bb_rate}}"""
    results = {}
    url = SAVANT_XSTATS_URL.format(season=season)
    try:
        resp = requests.get(url, timeout=20, headers={"User-Agent": "BetIntel/2.0"})
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        for row in reader:
            # Normalise column names to lowercase stripped
            row = {k.strip().lower(): v for k, v in row.items()}
            # Resolve player_id
            pid_raw = row.get("player_id") or row.get("mlb_id") or row.get("xmlbam_id")
            if not pid_raw:
                continue
            try:
                pid = int(pid_raw)
            except ValueError:
                continue
            record = {}
            # xERA
            for src_col, dst_col in [
                ("xera",          "p_xera"),
                ("xfip",          "p_xfip"),
                ("fip",           "p_fip"),
                ("p_swinging_strike", "p_swstr_rate"),
                ("swinging_strike_percent", "p_swstr_rate"),
                ("csw_rate",      "p_csw_rate"),
                ("k_percent",     "p_k_rate"),
                ("bb_percent",    "p_bb_rate"),
                ("gb_rate",       "p_gb_rate"),
                ("groundball_percent", "p_gb_rate"),
            ]:
                if src_col in row and row[src_col] not in ("", "null", "NULL", None):
                    record[dst_col] = _safe_float(row[src_col])
            if record:
                results[pid] = record
    except Exception as e:
        log.error(f"_fetch_savant_xstats: {e}")
    return results

# ── Helpers ──────────────────────────────────────────────────────────────────────
def _safe_float(val) -> float | None:
    try:
        return float(val) if val not in (None, "", "null", "NULL", "-") else None
    except (ValueError, TypeError):
        return None

def _compute_gaps(era: float | None, xera: float | None, fip: float | None):
    era_xera_gap = round(era - xera, 3) if era is not None and xera is not None else None
    era_fip_gap  = round(era - fip, 3)  if era is not None and fip  is not None else None
    return era_xera_gap, era_fip_gap

# ── Main entry point ──────────────────────────────────────────────────────────
def fetch_pitcher_stats():
    """Fetch and upsert pitcher_stats for the current season. Called daily."""
    season = datetime.now(ET).year
    now    = datetime.utcnow()

    log.info(f"fetch_pitcher_stats: fetching {season} season data")

    # Source 1: MLB StatsAPI — ERA + surface stats
    mlb_records = _fetch_mlb_era_stats(season)
    log.info(f"fetch_pitcher_stats: {len(mlb_records)} SPs from MLB StatsAPI")

    # Source 2: Baseball Savant — xERA, xFIP, FIP, SwStr%
    savant_records = _fetch_savant_xstats(season)
    log.info(f"fetch_pitcher_stats: {len(savant_records)} pitchers from Baseball Savant")

    # Merge: start with MLB surface stats, overlay Savant advanced stats
    merged = {}
    for pid, rec in mlb_records.items():
        merged[pid] = dict(rec)
    for pid, adv in savant_records.items():
        if pid in merged:
            merged[pid].update(adv)
        else:
            # Savant-only entry (may not be on an active SP roster yet)
            merged[pid] = {"pitcher_id": pid, **adv}

    if not merged:
        log.warning("fetch_pitcher_stats: no records to upsert — skipping")
        return

    conn = get_db()
    cur  = conn.cursor()
    upserted = 0

    for pid, rec in merged.items():
        era       = rec.get("p_era")
        xera      = rec.get("p_xera")
        fip       = rec.get("p_fip")
        era_xera_gap, era_fip_gap = _compute_gaps(era, xera, fip)

        try:
            cur.execute("""
                INSERT INTO pitcher_stats (
                    pitcher_id, full_name, team_id, season,
                    p_era, p_ip, p_k_per_9, p_bb_per_9, p_hr_per_9, p_whip,
                    p_xera, p_xfip, p_fip,
                    p_swstr_rate, p_csw_rate, p_k_rate, p_bb_rate, p_gb_rate,
                    era_xera_gap, era_fip_gap,
                    last_updated
                ) VALUES (
                    %(pitcher_id)s, %(full_name)s, %(team_id)s, %(season)s,
                    %(p_era)s, %(p_ip)s, %(p_k_per_9)s, %(p_bb_per_9)s, %(p_hr_per_9)s, %(p_whip)s,
                    %(p_xera)s, %(p_xfip)s, %(p_fip)s,
                    %(p_swstr_rate)s, %(p_csw_rate)s, %(p_k_rate)s, %(p_bb_rate)s, %(p_gb_rate)s,
                    %(era_xera_gap)s, %(era_fip_gap)s,
                    %(last_updated)s
                )
                ON CONFLICT (pitcher_id, season) DO UPDATE SET
                    full_name       = EXCLUDED.full_name,
                    team_id         = EXCLUDED.team_id,
                    p_era           = COALESCE(EXCLUDED.p_era,       pitcher_stats.p_era),
                    p_ip            = COALESCE(EXCLUDED.p_ip,        pitcher_stats.p_ip),
                    p_k_per_9       = COALESCE(EXCLUDED.p_k_per_9,   pitcher_stats.p_k_per_9),
                    p_bb_per_9      = COALESCE(EXCLUDED.p_bb_per_9,  pitcher_stats.p_bb_per_9),
                    p_hr_per_9      = COALESCE(EXCLUDED.p_hr_per_9,  pitcher_stats.p_hr_per_9),
                    p_whip          = COALESCE(EXCLUDED.p_whip,      pitcher_stats.p_whip),
                    p_xera          = COALESCE(EXCLUDED.p_xera,      pitcher_stats.p_xera),
                    p_xfip          = COALESCE(EXCLUDED.p_xfip,      pitcher_stats.p_xfip),
                    p_fip           = COALESCE(EXCLUDED.p_fip,       pitcher_stats.p_fip),
                    p_swstr_rate    = COALESCE(EXCLUDED.p_swstr_rate, pitcher_stats.p_swstr_rate),
                    p_csw_rate      = COALESCE(EXCLUDED.p_csw_rate,  pitcher_stats.p_csw_rate),
                    p_k_rate        = COALESCE(EXCLUDED.p_k_rate,    pitcher_stats.p_k_rate),
                    p_bb_rate       = COALESCE(EXCLUDED.p_bb_rate,   pitcher_stats.p_bb_rate),
                    p_gb_rate       = COALESCE(EXCLUDED.p_gb_rate,   pitcher_stats.p_gb_rate),
                    era_xera_gap    = COALESCE(EXCLUDED.era_xera_gap, pitcher_stats.era_xera_gap),
                    era_fip_gap     = COALESCE(EXCLUDED.era_fip_gap,  pitcher_stats.era_fip_gap),
                    last_updated    = EXCLUDED.last_updated
            """, {
                "pitcher_id":   pid,
                "full_name":    rec.get("full_name"),
                "team_id":      rec.get("team_id"),
                "season":       season,
                "p_era":        era,
                "p_ip":         rec.get("p_ip"),
                "p_k_per_9":    rec.get("p_k_per_9"),
                "p_bb_per_9":   rec.get("p_bb_per_9"),
                "p_hr_per_9":   rec.get("p_hr_per_9"),
                "p_whip":       rec.get("p_whip"),
                "p_xera":       xera,
                "p_xfip":       rec.get("p_xfip"),
                "p_fip":        fip,
                "p_swstr_rate": rec.get("p_swstr_rate"),
                "p_csw_rate":   rec.get("p_csw_rate"),
                "p_k_rate":     rec.get("p_k_rate"),
                "p_bb_rate":    rec.get("p_bb_rate"),
                "p_gb_rate":    rec.get("p_gb_rate"),
                "era_xera_gap": era_xera_gap,
                "era_fip_gap":  era_fip_gap,
                "last_updated": now,
            })
            upserted += 1
        except Exception as e:
            log.error(f"fetch_pitcher_stats: upsert pitcher {pid}: {e}")
            conn.rollback()
            continue

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_pitcher_stats: upserted {upserted} pitcher records for {season}")
