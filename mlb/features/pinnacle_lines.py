"""
mlb/features/pinnacle_lines.py
Pinnacle sharp line movement tracker for BetIntel MLB engine.

Polls the Pinnacle /v1/odds endpoint for MLB, compares opening line
vs current line per game/side. When movement exceeds SHARP_MOVE_THRESHOLD
(default 1.5 points), writes line_moved_sharp=True to the sharp_signals
table. The existing _has_secondary_signal() in compute_edges already
reads this table — no further changes needed there.

Env var required: PINNACLE_API_KEY (Base64-encoded username:password)
Get credentials at: agent.pinnacle.com (Pinnacle API — free for odds data)
"""

import os
import logging
from datetime import datetime, timezone
from functools import lru_cache

import requests
import psycopg2

from mlb.config import DATABASE_URL

log = logging.getLogger("betintel.features.pinnacle_lines")

# ── Configuration ────────────────────────────────────────────────────────────────
PINNACLE_MLB_SPORT_ID = 3        # Pinnacle sport ID for MLB
SHARP_MOVE_THRESHOLD  = 1.5      # points of ML/spread line move to flag as sharp
SHARP_MONEY_MIN_PCT   = 60.0     # % money on one side = sharp consensus
PINNACLE_BASE_URL     = "https://api.pinnacle.com"

# Pinnacle uses American odds internally; we store them in sharp_signals
# as sharp_money_pct proxy — actual % isn't exposed by Pinnacle API,
# so we use line movement magnitude as the primary sharp signal.


def _get_headers() -> dict | None:
    api_key = os.getenv("PINNACLE_API_KEY")
    if not api_key:
        log.warning("PINNACLE_API_KEY not set — Pinnacle line tracker disabled")
        return None
    return {
        "Authorization": f"Basic {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


@lru_cache(maxsize=1)
def _fetch_pinnacle_mlb_odds(today: str) -> list:
    """
    Fetch current MLB moneyline odds from Pinnacle.
    Cached for the process lifetime (today is the cache key).
    Returns list of event dicts or [] on failure.
    """
    headers = _get_headers()
    if not headers:
        return []
    try:
        resp = requests.get(
            f"{PINNACLE_BASE_URL}/v1/odds",
            headers=headers,
            params={
                "sportId": PINNACLE_MLB_SPORT_ID,
                "oddsFormat": "American",
                "since": 0,
            },
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json().get("leagues", [])
    except Exception as exc:
        log.error(f"Pinnacle odds fetch failed: {exc}")
        return []


@lru_cache(maxsize=1)
def _fetch_pinnacle_opening_lines(today: str) -> list:
    """
    Fetch opening lines (used as baseline for movement detection).
    Pinnacle exposes these via /v1/odds with since=0 at a specific snapshot.
    In practice we store the first fetch of the day as the opening line
    in sharp_signals.pinnacle_open via upsert logic below.
    """
    headers = _get_headers()
    if not headers:
        return []
    try:
        resp = requests.get(
            f"{PINNACLE_BASE_URL}/v1/fixtures",
            headers=headers,
            params={"sportId": PINNACLE_MLB_SPORT_ID, "isLive": 0},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json().get("league", {}).get("events", [])
    except Exception as exc:
        log.error(f"Pinnacle fixtures fetch failed: {exc}")
        return []


def _match_game_id(cur, home_name: str, away_name: str, event_date: str) -> str | None:
    """
    Match a Pinnacle event (home/away team names) to our internal game_id.
    Uses a fuzzy ILIKE match on team_name in the teams table joined to game_context.
    Returns game_id string or None if no match.
    """
    cur.execute("""
        SELECT gc.game_id
        FROM game_context gc
        JOIN teams th ON gc.home_team_id = th.team_id
        JOIN teams ta ON gc.away_team_id = ta.team_id
        WHERE gc.game_date = %s
          AND th.team_name ILIKE %s
          AND ta.team_name ILIKE %s
        LIMIT 1
    """, (event_date, f"%{home_name.split()[-1]}%", f"%{away_name.split()[-1]}%"))
    row = cur.fetchone()
    return row[0] if row else None


def fetch_pinnacle_lines() -> None:
    """
    Main entry point — called by APScheduler before compute_run_edges().

    For each MLB game today:
    1. Fetch current Pinnacle moneyline home/away odds
    2. Compare vs stored opening line in sharp_signals.pinnacle_open
    3. If movement >= SHARP_MOVE_THRESHOLD on either side: line_moved_sharp=True
    4. Upsert into sharp_signals for both 'home' and 'away' sides

    compute_edges._has_secondary_signal() already reads line_moved_sharp
    from sharp_signals — no further wiring needed.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    leagues = _fetch_pinnacle_mlb_odds(today)
    if not leagues:
        log.info("fetch_pinnacle_lines: no data returned, skipping")
        return

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()
    rows_written = 0

    for league in leagues:
        for event in league.get("events", []):
            home_name = event.get("home", "")
            away_name = event.get("away", "")
            event_date_str = (event.get("starts") or "")[:10]
            if event_date_str != today:
                continue

            game_id = _match_game_id(cur, home_name, away_name, today)
            if not game_id:
                log.debug(f"Pinnacle: no game_id match for {away_name} @ {home_name}")
                continue

            periods = event.get("periods", [])
            ml_period = next(
                (p for p in periods if p.get("number") == 0 and p.get("lineType") == "moneyline"),
                None
            )
            if not ml_period:
                continue

            home_current = ml_period.get("home")
            away_current = ml_period.get("away")
            if home_current is None or away_current is None:
                continue

            for side, current_odds in (("home", home_current), ("away", away_current)):
                # Fetch existing opening line if stored
                cur.execute("""
                    SELECT pinnacle_open, pinnacle_current
                    FROM sharp_signals
                    WHERE game_id=%s AND side=%s
                    ORDER BY created_at ASC LIMIT 1
                """, (game_id, side))
                existing = cur.fetchone()

                if existing is None:
                    # First fetch of the day — store as opening line
                    open_odds    = current_odds
                    line_moved   = False
                    move_mag     = 0.0
                else:
                    open_odds  = existing[0] if existing[0] is not None else current_odds
                    move_mag   = abs(current_odds - open_odds)
                    line_moved = move_mag >= SHARP_MOVE_THRESHOLD
                    if line_moved:
                        log.info(
                            f"SHARP_LINE_MOVE: game_id={game_id} side={side} "
                            f"open={open_odds} current={current_odds} "
                            f"move={move_mag:.1f} pts"
                        )

                cur.execute("""
                    INSERT INTO sharp_signals
                        (game_id, side, line_moved_sharp, sharp_money_pct,
                         pinnacle_open, pinnacle_current, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (game_id, side)
                    DO UPDATE SET
                        line_moved_sharp  = EXCLUDED.line_moved_sharp,
                        pinnacle_current  = EXCLUDED.pinnacle_current,
                        created_at        = EXCLUDED.created_at
                """, (
                    game_id, side, line_moved,
                    None,          # sharp_money_pct — not available from Pinnacle API
                    open_odds,
                    current_odds,
                ))
                rows_written += 1

    conn.commit()
    cur.close()
    conn.close()
    log.info(f"fetch_pinnacle_lines: {rows_written} sharp_signals rows upserted for {today}")
