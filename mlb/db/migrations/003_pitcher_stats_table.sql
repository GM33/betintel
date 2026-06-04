-- Migration 003: pitcher_stats table
-- Creates the pitcher_stats table that stores current-season advanced
-- pitching metrics (ERA, xERA, xFIP, FIP, SwStr%, GB%) for every active SP.
-- Populated daily by mlb/ingestion/pitcher_stats.py.
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING).

CREATE TABLE IF NOT EXISTS pitcher_stats (
    pitcher_id      INT         NOT NULL,
    full_name       VARCHAR,
    team_id         INT,
    season          INT         NOT NULL,
    -- Surface stats (MLB StatsAPI)
    p_era           FLOAT,
    p_ip            FLOAT,
    p_k_per_9       FLOAT,
    p_bb_per_9      FLOAT,
    p_hr_per_9      FLOAT,
    p_whip          FLOAT,
    p_gb_rate       FLOAT,
    -- Advanced regression stats (Baseball Savant)
    p_xera          FLOAT,      -- xERA: 1:1 translation of xwOBA to ERA scale
    p_xfip          FLOAT,      -- xFIP: normalises HR/FB rate
    p_fip           FLOAT,      -- FIP: fielding-independent ERA
    p_swstr_rate    FLOAT,      -- SwStr%: swinging strike rate
    p_csw_rate      FLOAT,      -- CSW%: called strike + whiff rate
    p_k_rate        FLOAT,      -- K%
    p_bb_rate       FLOAT,      -- BB%
    -- Computed gap signals (written here for fast lookup)
    era_xera_gap    FLOAT,      -- p_era - p_xera  (>2.0 = hard fade)
    era_fip_gap     FLOAT,      -- p_era - p_fip   (>1.2 = secondary flag)
    -- Meta
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (pitcher_id, season)
);

-- Fast lookup by game-day SP joins
CREATE INDEX IF NOT EXISTS idx_pitcher_stats_team
    ON pitcher_stats (team_id, season);

CREATE INDEX IF NOT EXISTS idx_pitcher_stats_era_gap
    ON pitcher_stats (pitcher_id)
    WHERE era_xera_gap IS NOT NULL;
