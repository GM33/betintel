"""Run this once to apply schema.sql to your production database."""
import psycopg2
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

def run_migrations():
    # Strip whitespace/newlines — Railway dashboard copy-paste sometimes
    # injects a trailing \n which causes psycopg2 to request database "railway\n"
    db_url = os.environ["DATABASE_URL"].strip()

    schema_path = Path(__file__).parent / "db" / "schema.sql"
    sql = schema_path.read_text()
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute(sql)
    conn.commit()
    cur.close()
    conn.close()
    print("✅ MLB schema migrations applied successfully.")

if __name__ == "__main__":
    run_migrations()
