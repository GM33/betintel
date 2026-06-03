-- ============================================================
--  BetIntel WNBA Database Schema
--  Run once: psql $DATABASE_URL -f wnba/schema.sql
-- ============================================================

-- ── Teams ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_teams (
    team_id         VARCHAR(16) PRIMARY KEY,
    league_id       VARCHAR(8)  NOT NULL DEFAULT 'WNBA',
    city            VARCHAR(64) NOT NULL,
    name            VARCHAR(64) NOT NULL,
    full_name       VARCHAR(128) NOT NULL,
    abbreviation    VARCHAR(8)  NOT NULL,
    conference      VARCHAR(16),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wnba_teams_abbr ON wnba_teams (abbreviation);

-- ── Players ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_players (
    player_id       INT PRIMARY KEY,
    team_id         VARCHAR(16) REFERENCES wnba_teams(team_id),
    first_name      VARCHAR(64) NOT NULL,
    last_name       VARCHAR(64) NOT NULL,
    full_name       VARCHAR(128) NOT NULL,
    position        VARCHAR(8),
    height_cm       INT,
    weight_kg       INT,
    birth_date      DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_players_team  ON wnba_players (team_id);
CREATE INDEX IF NOT EXISTS idx_wnba_players_name  ON wnba_players (last_name, first_name);

-- ── Games (schedule + identity) ──────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_games (
    game_id         VARCHAR(64) PRIMARY KEY,
    season          VARCHAR(8)  NOT NULL,
    season_type     VARCHAR(8)  NOT NULL DEFAULT 'REG',
    game_date       DATE        NOT NULL,
    tipoff_time     TIMESTAMPTZ NOT NULL,
    home_team_id    VARCHAR(16) NOT NULL REFERENCES wnba_teams(team_id),
    away_team_id    VARCHAR(16) NOT NULL REFERENCES wnba_teams(team_id),
    venue_name      VARCHAR(128),
    venue_city      VARCHAR(64),
    venue_state     VARCHAR(32),
    status          VARCHAR(16) NOT NULL DEFAULT 'SCHEDULED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_games_date       ON wnba_games (game_date);
CREATE INDEX IF NOT EXISTS idx_wnba_games_home_team  ON wnba_games (home_team_id, game_date);
CREATE INDEX IF NOT EXISTS idx_wnba_games_away_team  ON wnba_games (away_team_id, game_date);

-- ── Team game logs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_team_game_logs (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    team_id          VARCHAR(16) NOT NULL REFERENCES wnba_teams(team_id),
    is_home          BOOLEAN     NOT NULL,
    points           INT         NOT NULL,
    field_goals_made INT,
    field_goals_att  INT,
    three_made       INT,
    three_att        INT,
    free_throws_made INT,
    free_throws_att  INT,
    offensive_reb    INT,
    defensive_reb    INT,
    assists          INT,
    steals           INT,
    blocks           INT,
    turnovers        INT,
    fouls            INT,
    possessions      FLOAT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_team_logs_game ON wnba_team_game_logs (game_id);
CREATE INDEX IF NOT EXISTS idx_wnba_team_logs_team ON wnba_team_game_logs (team_id);

-- ── Player game logs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_player_game_logs (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    player_id        INT         NOT NULL REFERENCES wnba_players(player_id),
    team_id          VARCHAR(16) NOT NULL REFERENCES wnba_teams(team_id),
    minutes          FLOAT,
    points           INT,
    rebounds         INT,
    assists          INT,
    steals           INT,
    blocks           INT,
    turnovers        INT,
    fouls            INT,
    three_made       INT,
    three_att        INT,
    field_goals_made INT,
    field_goals_att  INT,
    free_throws_made INT,
    free_throws_att  INT,
    plus_minus       INT,
    usage_rate       FLOAT,
    offensive_rating FLOAT,
    defensive_rating FLOAT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_player_logs_game   ON wnba_player_game_logs (game_id);
CREATE INDEX IF NOT EXISTS idx_wnba_player_logs_player ON wnba_player_game_logs (player_id);
CREATE INDEX IF NOT EXISTS idx_wnba_player_logs_team   ON wnba_player_game_logs (team_id);

-- ── Game-level odds (moneyline, spread, total) ───────────────
CREATE TABLE IF NOT EXISTS wnba_game_odds (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    bookmaker        VARCHAR(64) NOT NULL,
    market           VARCHAR(16) NOT NULL,
    is_live          BOOLEAN     NOT NULL DEFAULT FALSE,
    home_moneyline   INT,
    away_moneyline   INT,
    spread_line      FLOAT,
    spread_home_odds INT,
    spread_away_odds INT,
    total_line       FLOAT,
    total_over_odds  INT,
    total_under_odds INT,
    odds_ts          TIMESTAMPTZ NOT NULL,
    UNIQUE (game_id, bookmaker, market, is_live)
);
CREATE INDEX IF NOT EXISTS idx_wnba_game_odds_game ON wnba_game_odds (game_id, bookmaker, market);
CREATE INDEX IF NOT EXISTS idx_wnba_game_odds_ts   ON wnba_game_odds (odds_ts DESC);

-- ── Player props odds ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_player_props (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    player_id        INT         NOT NULL REFERENCES wnba_players(player_id),
    bookmaker        VARCHAR(64) NOT NULL,
    prop_type        VARCHAR(32) NOT NULL,
    is_live          BOOLEAN     NOT NULL DEFAULT FALSE,
    line             FLOAT       NOT NULL,
    over_odds        INT         NOT NULL,
    under_odds       INT         NOT NULL,
    odds_ts          TIMESTAMPTZ NOT NULL,
    UNIQUE (game_id, player_id, bookmaker, prop_type, is_live)
);
CREATE INDEX IF NOT EXISTS idx_wnba_player_props_game   ON wnba_player_props (game_id, prop_type);
CREATE INDEX IF NOT EXISTS idx_wnba_player_props_player ON wnba_player_props (player_id, prop_type);
CREATE INDEX IF NOT EXISTS idx_wnba_player_props_ts     ON wnba_player_props (odds_ts DESC);

-- ── Odds history (full line movement, append-only) ───────────
CREATE TABLE IF NOT EXISTS wnba_odds_history (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    player_id        INT REFERENCES wnba_players(player_id),
    bookmaker        VARCHAR(64) NOT NULL,
    market_group     VARCHAR(16) NOT NULL,
    market_type      VARCHAR(32) NOT NULL,
    is_live          BOOLEAN     NOT NULL,
    home_moneyline   INT,
    away_moneyline   INT,
    spread_line      FLOAT,
    spread_home_odds INT,
    spread_away_odds INT,
    total_line       FLOAT,
    total_over_odds  INT,
    total_under_odds INT,
    prop_line        FLOAT,
    prop_over_odds   INT,
    prop_under_odds  INT,
    snapshot_source  VARCHAR(32),
    snapshot_type    VARCHAR(16),
    snapshot_ts      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wnba_odds_history_game_time   ON wnba_odds_history (game_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_wnba_odds_history_player_time ON wnba_odds_history (player_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_wnba_odds_history_market      ON wnba_odds_history (market_group, market_type, bookmaker);
CREATE INDEX IF NOT EXISTS idx_wnba_odds_history_is_live     ON wnba_odds_history (is_live, snapshot_ts DESC);

-- ── Model predictions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wnba_model_predictions (
    id              SERIAL PRIMARY KEY,
    game_id         VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    player_id       INT REFERENCES wnba_players(player_id),
    player_name     VARCHAR,
    market_type     VARCHAR(16) NOT NULL,
    prop_type       VARCHAR(32) NOT NULL,
    model_mean      FLOAT,
    model_mean_home FLOAT,
    model_mean_away FLOAT,
    p_over          FLOAT,
    p_under         FLOAT,
    p_home          FLOAT,
    p_away          FLOAT,
    edge_over       FLOAT,
    edge_under      FLOAT,
    edge_home       FLOAT,
    edge_away       FLOAT,
    line            FLOAT,
    over_odds       INT,
    under_odds      INT,
    home_odds       INT,
    away_odds       INT,
    card_decision   VARCHAR,
    confidence      VARCHAR,
    key_driver      TEXT,
    biggest_risk    TEXT,
    staking_pct     FLOAT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_model_predictions_game   ON wnba_model_predictions (game_id, market_type, prop_type);
CREATE INDEX IF NOT EXISTS idx_wnba_model_predictions_player ON wnba_model_predictions (player_id, prop_type, created_at DESC);

-- ── Player stat features (for modeling) ─────────────────────
CREATE TABLE IF NOT EXISTS wnba_player_game_features (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    date             DATE        NOT NULL,
    player_id        INT         NOT NULL REFERENCES wnba_players(player_id),
    player_name      VARCHAR,
    team_id          VARCHAR(16) REFERENCES wnba_teams(team_id),
    opp_team_id      VARCHAR(16) REFERENCES wnba_teams(team_id),
    home_away        INT,
    minutes_proj     FLOAT,
    usage_rate       FLOAT,
    pace_proj        FLOAT,
    points_per_min   FLOAT,
    rebounds_per_min FLOAT,
    assists_per_min  FLOAT,
    threes_per_min   FLOAT,
    true_shooting    FLOAT,
    offensive_rating FLOAT,
    defensive_rating FLOAT,
    rest_days        INT,
    back_to_back     BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wnba_features_game_player ON wnba_player_game_features (game_id, player_id);

-- ── Results (for calibration + backtesting) ──────────────────
CREATE TABLE IF NOT EXISTS wnba_results (
    game_id           VARCHAR(64) PRIMARY KEY REFERENCES wnba_games(game_id),
    home_points       INT,
    away_points       INT,
    game_total        INT,
    result_fetched_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wnba_player_boxscores (
    id               BIGSERIAL PRIMARY KEY,
    game_id          VARCHAR(64) NOT NULL REFERENCES wnba_games(game_id),
    player_id        INT         NOT NULL REFERENCES wnba_players(player_id),
    team_id          VARCHAR(16),
    minutes          FLOAT,
    points           INT,
    rebounds         INT,
    assists          INT,
    threes_made      INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
