import os
import psycopg2
import requests
from datetime import datetime

DATABASE_URL = os.environ.get("DATABASE_URL")
ODDS_API_KEY = os.environ.get("ODDS_API_KEY")
ODDS_API_BASE = "https://api.the-odds-api.com/v4"

MARKETS = ["h2h", "spreads", "totals"]
SPORT = "baseball_mlb"


def fetch_odds():
    url = f"{ODDS_API_BASE}/sports/{SPORT}/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": "us",
        "markets": ",".join(MARKETS),
        "oddsFormat": "american",
        "dateFormat": "iso",
    }
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def american_to_prob(line):
    if line is None:
        return None
    if line > 0:
        return round(100 / (line + 100), 4)
    else:
        return round(abs(line) / (abs(line) + 100), 4)


def upsert_snapshot(conn, game_id, market_type, outcome_label,
                   bookmaker, line, prob, snapped_at):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO mlb.market_snapshots
            (game_id, market_type, outcome_label, bookmaker, line, prob, snapped_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (game_id, market_type, outcome_label, bookmaker, snapped_at)
        DO NOTHING
    """, (game_id, market_type, outcome_label, bookmaker, line, prob, snapped_at))
    cur.close()


def run():
    print(f"[line_snapshots] Starting snapshot at {datetime.utcnow().isoformat()}")
    games = fetch_odds()
    conn = psycopg2.connect(DATABASE_URL)
    snapped_at = datetime.utcnow()
    count = 0

    for game in games:
        game_id = game.get("id")
        for bookmaker in game.get("bookmakers", []):
            bk_key = bookmaker.get("key")
            for market in bookmaker.get("markets", []):
                market_type = market.get("key")
                for outcome in market.get("outcomes", []):
                    label = outcome.get("name")
                    price = outcome.get("price")
                    point = outcome.get("point")
                    line_val = price
                    prob = american_to_prob(price)
                    # Encode point into label for spreads/totals
                    if point is not None:
                        label = f"{label} {point}"
                    upsert_snapshot(
                        conn, game_id, market_type, label,
                        bk_key, line_val, prob, snapped_at
                    )
                    count += 1

    conn.commit()
    conn.close()
    print(f"[line_snapshots] Inserted {count} rows.")


if __name__ == "__main__":
    run()
