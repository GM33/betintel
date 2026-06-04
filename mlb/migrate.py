"""Auto-migration runner.

Runs on every Railway deploy (called from startup.py before the pipeline).
Applies mlb/db/schema.sql first, then all mlb/db/migrations/NNN_*.sql files
in numeric order. Tracks applied migrations in a `migrations_log` table so
each file is executed exactly once — fully idempotent.
"""
import psycopg2
import logging
from pathlib import Path
from mlb.config import DATABASE_URL

log = logging.getLogger("betintel.migrate")

MIGRATIONS_DIR = Path(__file__).parent / "db" / "migrations"
SCHEMA_PATH    = Path(__file__).parent / "db" / "schema.sql"

CREATE_LOG = """
CREATE TABLE IF NOT EXISTS migrations_log (
    id          SERIAL PRIMARY KEY,
    filename    VARCHAR UNIQUE NOT NULL,
    applied_at  TIMESTAMPTZ DEFAULT NOW()
);
"""

def get_db():
    return psycopg2.connect(DATABASE_URL)

def run_migrations():
    conn = get_db()
    cur  = conn.cursor()

    # 1. Ensure migrations_log table exists
    cur.execute(CREATE_LOG)
    conn.commit()

    # 2. Apply base schema.sql (idempotent — all tables use IF NOT EXISTS)
    schema_sql = SCHEMA_PATH.read_text()
    cur.execute(schema_sql)
    conn.commit()
    log.info("migrate: base schema.sql applied")

    # 3. Discover and apply numbered migration files in order
    migration_files = sorted(
        MIGRATIONS_DIR.glob("[0-9][0-9][0-9]_*.sql"),
        key=lambda p: p.name
    )

    for mfile in migration_files:
        fname = mfile.name
        cur.execute("SELECT 1 FROM migrations_log WHERE filename = %s", (fname,))
        if cur.fetchone():
            log.info(f"migrate: {fname} already applied — skipping")
            continue
        try:
            sql = mfile.read_text()
            cur.execute(sql)
            cur.execute(
                "INSERT INTO migrations_log (filename) VALUES (%s)",
                (fname,)
            )
            conn.commit()
            log.info(f"migrate: {fname} ✅ applied")
        except Exception as e:
            conn.rollback()
            log.error(f"migrate: {fname} ❌ FAILED — {e}")
            raise  # surface to startup so Railway knows the deploy is broken

    cur.close()
    conn.close()
    log.info("migrate: all migrations complete")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_migrations()
    print("✅ All MLB migrations applied successfully.")
