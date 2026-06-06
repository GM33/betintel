import psycopg2
from mlb.config import DATABASE_URL
import logging

log = logging.getLogger("betintel.migrate")

MIGRATIONS = [
    # ── Core tables ──────────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS teams (
        team_id   SERIAL PRIMARY KEY,
        team_code VARCHAR(4) NOT NULL UNIQUE,
        team_name VARCHAR(64)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS game_context (
        game_id          VARCHAR(32) PRIMARY KEY,
        home_team_id     INT REFERENCES teams(team_id),
        away_team_id     INT REFERENCES teams(team_id),
        game_date        DATE,
        is_trap          BOOLEAN DEFAULT FALSE,
        home_sp_confirmed BOOLEAN DEFAULT TRUE,
        away_sp_confirmed BOOLEAN DEFAULT TRUE
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS model_predictions (
        id              SERIAL PRIMARY KEY,
        game_id         VARCHAR(32) REFERENCES game_context(game_id),
        player_id       INT,
        market_type     VARCHAR(16),
        model_mean      FLOAT,
        model_mean_home FLOAT,
        model_mean_away FLOAT,
        p_home          FLOAT,
        p_away          FLOAT,
        p_over          FLOAT,
        p_under         FLOAT,
        edge_home       FLOAT,
        edge_away       FLOAT,
        edge_over       FLOAT,
        edge_under      FLOAT,
        home_odds       INT,
        away_odds       INT,
        over_odds       INT,
        under_odds      INT,
        line            FLOAT,
        player_name     VARCHAR(64),
        card_decision   VARCHAR(24),
        staking_pct     FLOAT,
        high_variance   BOOLEAN DEFAULT FALSE,
        value_dog       BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS market_snapshots (
        id            SERIAL PRIMARY KEY,
        game_id       VARCHAR(32) REFERENCES game_context(game_id),
        player_id     INT,
        market_type   VARCHAR(16),
        prop_type     VARCHAR(32),
        home_odds     INT,
        away_odds     INT,
        over_odds     INT,
        under_odds    INT,
        line          FLOAT,
        snapshot_time TIMESTAMPTZ DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS bullpen_stats (
        team_id      INT REFERENCES teams(team_id),
        date         DATE,
        bp_ip_last_3d FLOAT,
        PRIMARY KEY (team_id, date)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS team_momentum (
        team_id              INT REFERENCES teams(team_id),
        date                 DATE,
        run_diff_last5       FLOAT,
        road_run_diff_last5  FLOAT,
        PRIMARY KEY (team_id, date)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS team_batting_stats (
        team_id       INT REFERENCES teams(team_id),
        date          DATE,
        lob_pct_last3 FLOAT,
        PRIMARY KEY (team_id, date)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS team_season_stats (
        team_id         INT REFERENCES teams(team_id),
        season          INT,
        season_run_diff FLOAT,
        wrc_plus_rank   INT,
        PRIMARY KEY (team_id, season)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS sharp_signals (
        id               SERIAL PRIMARY KEY,
        game_id          VARCHAR(32) REFERENCES game_context(game_id),
        side             VARCHAR(8),
        line_moved_sharp BOOLEAN DEFAULT FALSE,
        sharp_money_pct  FLOAT,
        sp_fip_edge      FLOAT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    """,
    # ── Weather columns on model_predictions (Jun 6 round 3) ─────────────────
    # Added by weather gate integration. Stored for post-mortem and threshold
    # tuning — allows us to answer whether weather rules are helping after 7 days.
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_temp_f        FLOAT;",
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_wind_mph       FLOAT;",
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_wind_deg       FLOAT;",
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_rain_prob      FLOAT;",
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_multiplier     FLOAT;",
    "ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS weather_gate_triggered BOOLEAN DEFAULT FALSE;",
]

def run_migrations():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    for sql in MIGRATIONS:
        try:
            cur.execute(sql)
        except Exception as e:
            log.error(f"Migration error: {e}\nSQL: {sql}")
            conn.rollback()
            raise
    conn.commit()
    cur.close()
    conn.close()
    log.info("Migrations complete")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_migrations()
