-- Migration 005: batter_prop_features table
-- Stores per-batter per-game feature rows for hits and total bases prop models.
-- Populated daily by mlb/features/build_batter_prop_features.py.

CREATE TABLE IF NOT EXISTS batter_prop_features (
    id                      SERIAL PRIMARY KEY,
    game_id                 VARCHAR NOT NULL,
    player_id               INT     NOT NULL,
    player_name             VARCHAR,
    team_id                 INT,
    is_home                 INT,          -- 1=home, 0=away
    batting_order           INT,          -- 1-9 slot
    date                    DATE,
    season                  INT,

    -- Rolling batting performance
    hits_last_7g            FLOAT,        -- hits/game last 7 games
    hits_last_15g           FLOAT,        -- hits/game last 15 games
    hits_season_avg         FLOAT,        -- season H/PA rate
    tb_last_7g              FLOAT,        -- total bases/game last 7
    tb_last_15g             FLOAT,        -- total bases/game last 15
    tb_season_avg           FLOAT,        -- season TB/PA rate

    -- Platoon & matchup
    batter_hand             INT,          -- 1=R, 0=L
    sp_hand                 INT,          -- 1=R, 0=L
    avg_vs_hand             FLOAT,        -- season AVG vs SP hand
    slg_vs_hand             FLOAT,        -- season SLG vs SP hand
    obp_vs_hand             FLOAT,        -- season OBP vs SP hand
    wrc_plus_vs_hand        FLOAT,        -- wRC+ vs SP hand

    -- Opposing SP regression signals
    opp_sp_era              FLOAT,
    opp_sp_xera             FLOAT,
    opp_sp_fip              FLOAT,
    opp_sp_era_xera_gap     FLOAT,        -- key fade signal
    opp_sp_swstr_rate       FLOAT,
    opp_sp_k_rate           FLOAT,
    opp_sp_bb_rate          FLOAT,
    opp_sp_gb_rate          FLOAT,

    -- Park & environment
    park_runs_factor        FLOAT,        -- park factor for runs
    park_hr_factor          FLOAT,        -- park factor for HRs
    temp_f                  FLOAT,
    wind_out_speed          FLOAT,        -- mph blowing out (positive = over lean)
    wind_in_speed           FLOAT,        -- mph blowing in  (positive = under lean)

    -- Actuals (filled post-game by build_k_features pattern)
    actual_hits             INT,
    actual_tb               INT,

    created_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_bpf_player_date
    ON batter_prop_features (player_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_bpf_game
    ON batter_prop_features (game_id);

CREATE INDEX IF NOT EXISTS idx_bpf_opp_era_gap
    ON batter_prop_features (opp_sp_era_xera_gap)
    WHERE opp_sp_era_xera_gap IS NOT NULL;
