-- Migration 003: pitcher_stats table (patched)
-- Handles case where table exists without team_id from a prior failed run.

-- Drop and recreate cleanly to ensure correct schema
DROP TABLE IF EXISTS pitcher_stats CASCADE;

CREATE TABLE pitcher_stats (
    pitcher_id      INT         NOT NULL,
    full_name       VARCHAR,
    team_id         INT,
    season          INT         NOT NULL,
    p_era           FLOAT,
    p_ip            FLOAT,
    p_k_per_9       FLOAT,
    p_bb_per_9      FLOAT,
    p_hr_per_9      FLOAT,
    p_whip          FLOAT,
    p_gb_rate       FLOAT,
    p_xera          FLOAT,
    p_xfip          FLOAT,
    p_fip           FLOAT,
    p_swstr_rate    FLOAT,
    p_csw_rate      FLOAT,
    p_k_rate        FLOAT,
    p_bb_rate       FLOAT,
    era_xera_gap    FLOAT,
    era_fip_gap     FLOAT,
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (pitcher_id, season)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_stats_team
    ON pitcher_stats (team_id, season);

CREATE INDEX IF NOT EXISTS idx_pitcher_stats_era_gap
    ON pitcher_stats (pitcher_id)
    WHERE era_xera_gap IS NOT NULL;
