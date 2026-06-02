"""Quick check: shows how many rows exist in each MLB engine table.
Run after migration to verify DB is ready.
"""
import psycopg2
from dotenv import load_dotenv
import os

load_dotenv()

TABLES = [
    "game_context",
    "bullpen_stats",
    "market_snapshots",
    "game_id_map",
    "pitcher_k_games",
    "game_run_data",
    "model_predictions",
    "results",
    "model_calibration"
]

def check():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    print("\nBetIntel MLB — Table Row Counts")
    print("-" * 40)
    for t in TABLES:
        try:
            cur.execute(f"SELECT COUNT(*) FROM {t}")
            count = cur.fetchone()[0]
            status = "✅" if count > 0 else "⚠️  empty"
            print(f"  {t:<35} {count:>6}  {status}")
        except Exception as e:
            print(f"  {t:<35} ERROR: {e}")
    cur.close()
    conn.close()

if __name__ == "__main__":
    check()
