"""
mlb/features/weather_gate.py
Weather gate for BetIntel MLB engine — OpenWeather One Call API 2.5
Pulls stadium-level forecast by lat/lon, returns a run-environment
multiplier and a rain-gate boolean for use in compute_run_edges().

Env var required: WEATHER_API_KEY (openweathermap.org free tier works)
"""

import os
import logging
from functools import lru_cache

import requests

log = logging.getLogger("betintel.features.weather_gate")

# ── Thresholds ────────────────────────────────────────────────────────────────
WEATHER_WIND_OUT_BOOST  = 0.06   # strong wind blowing toward OF → more runs
WEATHER_WIND_IN_PENALTY = 0.05   # strong wind blowing in → fewer runs
WEATHER_COLD_PENALTY    = 0.04   # cold air suppresses runs
WEATHER_HOT_BUMP        = 0.03   # hot air boosts runs slightly
WEATHER_RAIN_LEAN_PROB  = 0.45   # precip probability → auto-LEAN
WEATHER_STRONG_WIND_MPH = 12.0   # mph threshold to trigger wind adjustments

# ── Stadium coordinates — all 30 MLB parks ───────────────────────────────────
BALLPARK_COORDS = {
    "ARI": {"name": "Chase Field",                  "lat": 33.4455,  "lon": -112.0667},
    "ATL": {"name": "Truist Park",                   "lat": 33.8907,  "lon": -84.4677},
    "BAL": {"name": "Oriole Park at Camden Yards",   "lat": 39.2838,  "lon": -76.6217},
    "BOS": {"name": "Fenway Park",                   "lat": 42.3467,  "lon": -71.0972},
    "CHC": {"name": "Wrigley Field",                 "lat": 41.9484,  "lon": -87.6553},
    "CHW": {"name": "Rate Field",                    "lat": 41.8300,  "lon": -87.6338},
    "CIN": {"name": "Great American Ball Park",      "lat": 39.0979,  "lon": -84.5081},
    "CLE": {"name": "Progressive Field",             "lat": 41.4962,  "lon": -81.6852},
    "COL": {"name": "Coors Field",                   "lat": 39.7559,  "lon": -104.9942},
    "DET": {"name": "Comerica Park",                 "lat": 42.3390,  "lon": -83.0485},
    "HOU": {"name": "Daikin Park",                   "lat": 29.7573,  "lon": -95.3555},
    "KC":  {"name": "Kauffman Stadium",              "lat": 39.0517,  "lon": -94.4803},
    "LAA": {"name": "Angel Stadium",                 "lat": 33.8003,  "lon": -117.8827},
    "LAD": {"name": "Dodger Stadium",                "lat": 34.0739,  "lon": -118.2400},
    "MIA": {"name": "loanDepot park",               "lat": 25.7781,  "lon": -80.2197},
    "MIL": {"name": "American Family Field",         "lat": 43.0280,  "lon": -87.9712},
    "MIN": {"name": "Target Field",                  "lat": 44.9817,  "lon": -93.2776},
    "NYM": {"name": "Citi Field",                    "lat": 40.7571,  "lon": -73.8458},
    "NYY": {"name": "Yankee Stadium",                "lat": 40.8296,  "lon": -73.9262},
    "ATH": {"name": "Sutter Health Park",            "lat": 38.5806,  "lon": -121.5136},
    "PHI": {"name": "Citizens Bank Park",            "lat": 39.9061,  "lon": -75.1665},
    "PIT": {"name": "PNC Park",                      "lat": 40.4469,  "lon": -80.0057},
    "SD":  {"name": "Petco Park",                    "lat": 32.7073,  "lon": -117.1566},
    "SF":  {"name": "Oracle Park",                   "lat": 37.7786,  "lon": -122.3893},
    "SEA": {"name": "T-Mobile Park",                 "lat": 47.5914,  "lon": -122.3325},
    "STL": {"name": "Busch Stadium",                 "lat": 38.6226,  "lon": -90.1928},
    "TB":  {"name": "George M. Steinbrenner Field",  "lat": 27.9800,  "lon": -82.5062},
    "TEX": {"name": "Globe Life Field",              "lat": 32.7473,  "lon": -97.0847},
    "TOR": {"name": "Rogers Centre",                 "lat": 43.6414,  "lon": -79.3894},
    "WSH": {"name": "Nationals Park",               "lat": 38.8730,  "lon": -77.0074},
}

# ── Approximate outfield bearing (degrees from North) per park ───────────────
# Used to determine whether wind blows toward ("out") or away from ("in")
# the outfield wall. Angles are approximate centre-field compass bearings.
BALLPARK_OUTFIELD_BEARING = {
    "ARI": 62,  "ATL": 52,  "BAL": 60,  "BOS": 54,  "CHC": 50,
    "CHW": 49,  "CIN": 58,  "CLE": 52,  "COL": 55,  "DET": 61,
    "HOU": 57,  "KC":  59,  "LAA": 60,  "LAD": 54,  "MIA": 59,
    "MIL": 55,  "MIN": 56,  "NYM": 60,  "NYY": 54,  "ATH": 58,
    "PHI": 60,  "PIT": 58,  "SD":  53,  "SF":  60,  "SEA": 54,
    "STL": 60,  "TB":  56,  "TEX": 58,  "TOR": 58,  "WSH": 60,
}

# Domed / fully retractable parks — weather gate never fires for these.
# Wind and rain are irrelevant; temperature effect is muted.
DOMED_PARKS = {"ARI", "HOU", "MIA", "MIL", "SEA", "TB", "TOR", "TEX"}


def _angle_diff(a: float, b: float) -> float:
    """Smallest angular difference between two compass bearings (0-360)."""
    d = abs(a - b) % 360
    return min(d, 360 - d)


@lru_cache(maxsize=64)
def _fetch_onecall(lat: float, lon: float) -> dict | None:
    """
    Fetch OpenWeather One Call API 2.5 payload for given coordinates.
    Cached per (lat, lon) for the lifetime of the process run.
    Returns None if WEATHER_API_KEY is unset or request fails.
    """
    api_key = os.getenv("WEATHER_API_KEY")
    if not api_key:
        log.warning("WEATHER_API_KEY not set — weather gate disabled")
        return None

    url = (
        f"https://api.openweathermap.org/data/2.5/onecall"
        f"?lat={lat}&lon={lon}"
        f"&exclude=minutely,daily,alerts"
        f"&units=imperial"
        f"&appid={api_key}"
    )
    try:
        resp = requests.get(url, timeout=8)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.error(f"OpenWeather fetch failed lat={lat} lon={lon}: {exc}")
        return None


def _extract_hour(payload: dict, game_hour_idx: int = 0) -> dict | None:
    """
    Pull forecast data for the target game hour from hourly array.
    game_hour_idx=0 → first available hour (default for same-day games).
    Returns dict with temp_f, wind_mph, wind_deg, rain_prob.
    """
    hourly = (payload or {}).get("hourly", [])
    if not hourly:
        return None
    h = hourly[min(game_hour_idx, len(hourly) - 1)]
    return {
        "temp_f":    float(h["temp"]) if h.get("temp") is not None else None,
        "wind_mph":  float(h.get("wind_speed", 0.0)),
        "wind_deg":  float(h["wind_deg"]) if h.get("wind_deg") is not None else None,
        "rain_prob": float(h.get("pop", 0.0)),
    }


def get_weather_adjustment(
    home_team_code: str,
    game_hour_idx: int = 0,
) -> tuple[float, bool, dict]:
    """
    Primary entry point for compute_run_edges().

    Returns:
        multiplier  (float)  — apply to both mu_h and mu_a
        rain_gate   (bool)   — True → auto-LEAN this game
        wx_meta     (dict)   — raw weather values for DB logging

    If WEATHER_API_KEY is missing or park is domed, returns (1.0, False, {}).
    """
    code = (home_team_code or "").upper()

    # Domed parks — skip entirely
    if code in DOMED_PARKS:
        log.debug(f"WEATHER_GATE skipped (domed park): {code}")
        return 1.0, False, {"dome": True}

    park = BALLPARK_COORDS.get(code)
    if not park:
        log.warning(f"WEATHER_GATE: unknown team code '{code}' — skipping")
        return 1.0, False, {}

    payload = _fetch_onecall(park["lat"], park["lon"])
    wx = _extract_hour(payload, game_hour_idx=game_hour_idx)
    if not wx:
        return 1.0, False, {}

    mult = 1.0
    rain_gate = wx["rain_prob"] >= WEATHER_RAIN_LEAN_PROB

    if not rain_gate:
        outfield_deg = BALLPARK_OUTFIELD_BEARING.get(code)
        if outfield_deg is not None and wx["wind_deg"] is not None:
            toward_out = _angle_diff(wx["wind_deg"], outfield_deg) <= 45
            toward_in  = _angle_diff(wx["wind_deg"], (outfield_deg + 180) % 360) <= 45

            if wx["wind_mph"] >= WEATHER_STRONG_WIND_MPH and toward_out:
                mult += WEATHER_WIND_OUT_BOOST
                log.info(f"WEATHER wind_out: {code} wind={wx['wind_mph']}mph deg={wx['wind_deg']} -> mult+{WEATHER_WIND_OUT_BOOST}")
            elif wx["wind_mph"] >= WEATHER_STRONG_WIND_MPH and toward_in:
                mult -= WEATHER_WIND_IN_PENALTY
                log.info(f"WEATHER wind_in: {code} wind={wx['wind_mph']}mph deg={wx['wind_deg']} -> mult-{WEATHER_WIND_IN_PENALTY}")

        if wx["temp_f"] is not None:
            if wx["temp_f"] <= 55:
                mult -= WEATHER_COLD_PENALTY
                log.info(f"WEATHER cold: {code} temp={wx['temp_f']}F -> mult-{WEATHER_COLD_PENALTY}")
            elif wx["temp_f"] >= 85:
                mult += WEATHER_HOT_BUMP
                log.info(f"WEATHER hot: {code} temp={wx['temp_f']}F -> mult+{WEATHER_HOT_BUMP}")

    mult = max(mult, 0.85)  # floor: never suppress below 85% of base

    if rain_gate:
        log.warning(
            f"WEATHER_RAIN_GATE: {code} rain_prob={wx['rain_prob']:.2f} "
            f"temp={wx['temp_f']} wind={wx['wind_mph']}mph"
        )

    return mult, rain_gate, wx
