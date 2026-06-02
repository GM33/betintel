import requests
import psycopg2
from datetime import datetime
from mlb.config import WEATHER_API_KEY, DATABASE_URL
import logging

log = logging.getLogger("betintel.ingestion.weather")

VENUE_COORDS = {
    3312: (41.8299, -87.6338),
    2392: (40.8296, -73.9262),
    2395: (42.3467, -71.0972),
    2394: (40.7571, -73.8458),
    2681: (39.9056, -75.1665),
    2500: (38.8730, -77.0074),
    4705: (33.4453, -112.0667),
    2602: (37.7786, -122.3893),
    4169: (39.7559, -104.9942),
    2602: (37.7786, -122.3893),
    2519: (47.5914, -122.3325),
    4705: (33.4453, -112.0667),
    14: (41.4962, -81.6852),
    2523: (32.7512, -97.0832),
    4140: (29.7573, -95.3555),
    3289: (34.0739, -118.2400),
    2407: (25.7781, -80.2197),
    4480: (43.6414, -79.3894),
}

def get_db():
    return psycopg2.connect(DATABASE_URL)

def fetch_weather_for_today():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT game_id, venue_id FROM game_context
        WHERE DATE(game_date AT TIME ZONE 'America/New_York') = CURRENT_DATE
          AND weather_temp_f IS NULL
    """)
    rows = cur.fetchall()

    for game_id, venue_id in rows:
        coords = VENUE_COORDS.get(venue_id)
        if not coords:
            continue
        lat, lon = coords
        try:
            resp = requests.get(
                "https://api.openweathermap.org/data/2.5/forecast",
                params={"lat": lat, "lon": lon, "appid": WEATHER_API_KEY, "units": "imperial"},
                timeout=10
            )
            resp.raise_for_status()
            forecast = resp.json()
            slot = forecast["list"][0]
            cur.execute("""
                UPDATE game_context SET
                    weather_temp_f=%s, weather_wind_mph=%s,
                    weather_wind_dir_deg=%s, weather_conditions=%s,
                    last_updated=%s
                WHERE game_id=%s
            """, (
                slot["main"]["temp"],
                slot["wind"]["speed"],
                slot["wind"].get("deg"),
                slot["weather"][0]["description"],
                datetime.utcnow(), game_id
            ))
        except Exception as e:
            log.error(f"fetch_weather: {game_id}: {e}")

    conn.commit()
    cur.close()
    conn.close()
    log.info("fetch_weather_for_today: complete")
