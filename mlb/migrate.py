"""Run this once to apply schema.sql to your production database."""
import psycopg2
from pathlib import Path

# Internal Railway hostname — no env var needed
_DB_URL = (
    "postgresql://postgres:cgktPPerQvmdJMyAuYcMAxkUsqoniycZ"
    "@postgres.railway.internal:5432/railway"
)


def run_migrations():
    schema_path = Path(__file__).parent / "db" / "schema.sql"
    sql = schema_path.read_text()
    conn = psycopg2.connect(_DB_URL)
    cur = conn.cursor()
    cur.execute(sql)
    conn.commit()
    cur.close()
    conn.close()
    print("✅ MLB schema migrations applied successfully.")


if __name__ == "__main__":
    run_migrations()
