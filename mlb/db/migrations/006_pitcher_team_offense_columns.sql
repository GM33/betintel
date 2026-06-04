-- Migration 006: Add missing columns to pitcher_stats and team_offense_stats
-- Safe: uses IF NOT EXISTS / DO NOTHING patterns throughout
-- Run after 005_june3_model_upgrades.sql

-- ── pitcher_stats ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pitcher_stats (
    player_id   INTEGER     NOT NULL,
    player_name TEXT        NOT NULL,
    season      SMALLINT    NOT NULL,
    era         NUMERIC(5,2),
    xfip        NUMERIC(5,2),
    fip         NUMERIC(5,2),
    xera        NUMERIC(5,2),
    k_pct       NUMERIC(5,2),
    bb_pct      NUMERIC(5,2),
    ip          NUMERIC(6,1),
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (player_id, season)
);

-- Add columns that may be missing on existing installs
ALTER TABLE pitcher_stats ADD COLUMN IF NOT EXISTS xera         NUMERIC(5,2);
ALTER TABLE pitcher_stats ADD COLUMN IF NOT EXISTS k_pct        NUMERIC(5,2);
ALTER TABLE pitcher_stats ADD COLUMN IF NOT EXISTS bb_pct       NUMERIC(5,2);
ALTER TABLE pitcher_stats ADD COLUMN IF NOT EXISTS ip           NUMERIC(6,1);
ALTER TABLE pitcher_stats ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ DEFAULT NOW();

-- ── team_offense_stats ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_offense_stats (
    team_id             INTEGER      NOT NULL,
    team_name           TEXT,
    team_abbrev         VARCHAR(5),
    season              SMALLINT     NOT NULL,
    slugging_pct        NUMERIC(5,4),
    slugging_pct_recent NUMERIC(5,4),
    obp                 NUMERIC(5,4),
    ops                 NUMERIC(5,4),
    batting_avg         NUMERIC(5,4),
    hr_season           INTEGER,
    wrc_plus            INTEGER,
    last_updated        TIMESTAMPTZ  DEFAULT NOW(),
    PRIMARY KEY (team_id, season)
);

-- Add columns that may be missing on existing installs
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS team_abbrev         VARCHAR(5);
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS slugging_pct_recent NUMERIC(5,4);
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS obp                 NUMERIC(5,4);
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS ops                 NUMERIC(5,4);
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS batting_avg         NUMERIC(5,4);
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS hr_season           INTEGER;
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS wrc_plus            INTEGER;
ALTER TABLE team_offense_stats ADD COLUMN IF NOT EXISTS last_updated        TIMESTAMPTZ DEFAULT NOW();

-- Index for fast lookup by build_game_features
CREATE INDEX IF NOT EXISTS idx_pitcher_stats_season      ON pitcher_stats      (season, player_id);
CREATE INDEX IF NOT EXISTS idx_team_offense_stats_season ON team_offense_stats (season, team_id);
