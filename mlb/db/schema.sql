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
    team_wrc_plus_vs_hand FLOAT,
    team_iso_vs_hand FLOAT,
    team_obp_vs_hand FLOAT,
    opp_sp_xfip FLOAT,
    opp_sp_fip FLOAT,
    opp_sp_k_minus_bb FLOAT,
    opp_sp_gb_rate FLOAT,
    opp_bp_xfip FLOAT,
    opp_bp_ip_last_3d FLOAT,
    park_runs_factor FLOAT,
    temp_f FLOAT,
    wind_speed_mph FLOAT,
    start_time_bucket VARCHAR,
    league VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW()
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
