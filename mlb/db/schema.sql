CREATE TABLE IF NOT EXISTS game_context (
    game_id VARCHAR PRIMARY KEY,
    odds_event_id VARCHAR,
    game_date TIMESTAMPTZ,
    venue_id INT,
    venue_name VARCHAR,
    home_team_id INT,
    away_team_id INT,
    home_sp_id INT,
    away_sp_id INT,
    home_lineup INT[],
    away_lineup INT[],
    sp_confirmed BOOLEAN DEFAULT FALSE,
    lineup_confirmed BOOLEAN DEFAULT FALSE,
    umpire_id INT,
    umpire_confirmed BOOLEAN DEFAULT FALSE,
    weather_temp_f FLOAT,
    weather_wind_mph FLOAT,
    weather_wind_dir_deg FLOAT,
    weather_conditions VARCHAR,
    last_updated TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bullpen_stats (
    team_id INT,
    date DATE,
    bp_ip_last_1d FLOAT,
    bp_ip_last_3d FLOAT,
    bp_relievers_used_last_1d INT,
    bp_relievers_used_last_3d INT,
    created_at TIMESTAMPTZ,
    PRIMARY KEY (team_id, date)
);

CREATE TABLE IF NOT EXISTS market_snapshots (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR,
    odds_event_id VARCHAR,
    player_id INT,
    player_name VARCHAR,
    market_type VARCHAR,
    prop_type VARCHAR,
    bookmaker VARCHAR,
    line FLOAT,
    over_odds INT,
    under_odds INT,
    home_odds INT,
    away_odds INT,
    snapshot_type VARCHAR,
    snapshot_time TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS game_id_map (
    odds_event_id VARCHAR PRIMARY KEY,
    mlb_game_pk VARCHAR,
    home_team VARCHAR,
    away_team VARCHAR,
    commence_time TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pitcher_k_games (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR,
    date DATE,
    pitcher_id INT,
    team_id INT,
    opp_team_id INT,
    home_away INT,
    league VARCHAR,
    k_outs INT,
    p_k_rate FLOAT,
    p_k_rate_vs_hand FLOAT,
    p_bb_rate FLOAT,
    p_swstr_rate FLOAT,
    p_ip_per_start FLOAT,
    p_hand INT,
    opp_k_rate_vs_hand FLOAT,
    opp_bb_rate_vs_hand FLOAT,
    g_park_id VARCHAR,
    bp_ip_last_3d FLOAT,
    bp_relievers_used_last_3d INT,
    ump_k_rate_diff FLOAT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_run_data (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR,
    team_id INT,
    is_home INT,
    date DATE,
    runs_scored INT,

    -- Existing offensive context
    team_wrc_plus_vs_hand FLOAT,
    team_iso_vs_hand FLOAT,
    team_obp_vs_hand FLOAT,

    -- Existing pitching context
    opp_sp_xfip FLOAT,
    opp_sp_fip FLOAT,
    opp_sp_k_minus_bb FLOAT,
    opp_sp_gb_rate FLOAT,
    opp_bp_xfip FLOAT,
    opp_bp_ip_last_3d FLOAT,

    -- Existing environment
    park_runs_factor FLOAT,
    temp_f FLOAT,
    wind_speed_mph FLOAT,
    start_time_bucket VARCHAR,
    league VARCHAR,

    -- June 3 upgrade: slugging variance
    team_slg_recent FLOAT,
    opp_slg_recent FLOAT,
    team_slg_delta FLOAT GENERATED ALWAYS AS (team_slg_recent - opp_slg_recent) STORED,

    -- June 3 upgrade: xERA regression gap
    sp_era FLOAT,
    sp_proj_era FLOAT,
    sp_era_gap FLOAT GENERATED ALWAYS AS (sp_proj_era - sp_era) STORED,

    -- June 3 upgrade: bullpen fatigue index
    bp_fatigue_idx FLOAT,

    -- June 3 upgrade: park total adjustment
    park_total_adjustment FLOAT GENERATED ALWAYS AS (park_runs_factor - 1.0) STORED,

    -- June 3 upgrade: road underdog confidence flag
    underdog_confidence_flag SMALLINT DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pitcher_stats (
    pitcher_id INT,
    p_k_rate FLOAT,
    p_k_rate_vs_hand FLOAT,
    p_bb_rate FLOAT,
    p_swstr_rate FLOAT,
    p_ip_per_start FLOAT,
    p_hand INT,
    -- June 3 upgrade: regression metrics
    era FLOAT,
    xfip FLOAT,
    fip FLOAT,
    last_updated TIMESTAMPTZ,
    PRIMARY KEY (pitcher_id, last_updated)
);

CREATE TABLE IF NOT EXISTS team_offense_stats (
    team_id INT,
    k_rate_vs_rh FLOAT,
    k_rate_vs_lh FLOAT,
    -- June 3 upgrade: slugging %
    slugging_pct FLOAT,
    last_updated TIMESTAMPTZ,
    PRIMARY KEY (team_id, last_updated)
);

CREATE TABLE IF NOT EXISTS model_predictions (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR,
    player_id INT,
    player_name VARCHAR,
    market_type VARCHAR,
    prop_type VARCHAR,
    model_mean FLOAT,
    model_mean_home FLOAT,
    model_mean_away FLOAT,
    p_over FLOAT,
    p_under FLOAT,
    p_home FLOAT,
    p_away FLOAT,
    edge_over FLOAT,
    edge_under FLOAT,
    edge_home FLOAT,
    edge_away FLOAT,
    line FLOAT,
    over_odds INT,
    under_odds INT,
    home_odds INT,
    away_odds INT,
    card_decision VARCHAR,
    confidence VARCHAR,
    key_driver TEXT,
    biggest_risk TEXT,
    staking_pct FLOAT,
    -- June 3 upgrade: analyst feature signals
    sp_era_gap FLOAT,
    bp_fatigue_idx FLOAT,
    park_total_adjustment FLOAT,
    underdog_confidence_flag SMALLINT DEFAULT 0,
    team_slg_delta FLOAT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS results (
    game_id VARCHAR PRIMARY KEY,
    home_runs INT,
    away_runs INT,
    home_sp_id INT,
    away_sp_id INT,
    home_sp_ks INT,
    away_sp_ks INT,
    home_sp_ip FLOAT,
    away_sp_ip FLOAT,
    game_total INT,
    result_fetched_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS model_calibration (
    id SERIAL PRIMARY KEY,
    market_type VARCHAR,
    last_n_days INT,
    brier_score FLOAT,
    mae FLOAT,
    roi FLOAT,
    sample_size INT,
    drift_alert BOOLEAN DEFAULT FALSE,
    computed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for June 3 upgrade feature columns
CREATE INDEX IF NOT EXISTS idx_game_run_data_era_gap
    ON game_run_data (sp_era_gap DESC NULLS LAST)
    WHERE sp_era_gap IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_run_data_bp_fatigue
    ON game_run_data (bp_fatigue_idx DESC NULLS LAST)
    WHERE bp_fatigue_idx IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_run_data_underdog_flag
    ON game_run_data (underdog_confidence_flag)
    WHERE underdog_confidence_flag = 1;

CREATE INDEX IF NOT EXISTS idx_model_predictions_era_gap
    ON model_predictions (sp_era_gap DESC NULLS LAST)
    WHERE sp_era_gap IS NOT NULL;
