-- Migration 002: Model Upgrade v2 — June 3 Calibration
-- Adds xERA/FIP gap columns, wind direction features, SLG variance signals,
-- park-adjusted total, and away_slg_delta to support the June 3 model upgrade.
-- Safe to run multiple times (all ADD COLUMN IF NOT EXISTS).

-- ── pitcher_k_games: add ERA regression gap columns ──────────────────────────
ALTER TABLE pitcher_k_games
    ADD COLUMN IF NOT EXISTS p_era       FLOAT,
    ADD COLUMN IF NOT EXISTS p_xera      FLOAT,
    ADD COLUMN IF NOT EXISTS p_xfip      FLOAT,
    ADD COLUMN IF NOT EXISTS p_fip       FLOAT,
    ADD COLUMN IF NOT EXISTS era_xera_gap FLOAT,  -- p_era - p_xera; >2.0 = hard fade
    ADD COLUMN IF NOT EXISTS era_fip_gap  FLOAT;  -- p_era - p_fip;  >1.2 = secondary flag

-- ── game_run_data: add all June 3 upgrade feature columns ───────────────────
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS wind_out_speed    FLOAT,   -- tailwind component (mph)
    ADD COLUMN IF NOT EXISTS wind_in_speed     FLOAT,   -- headwind component (mph)
    ADD COLUMN IF NOT EXISTS team_slg_last_7d  FLOAT,   -- rolling 7-game SLG proxy
    ADD COLUMN IF NOT EXISTS team_slg_last_10  FLOAT,   -- rolling 10-game SLG proxy
    ADD COLUMN IF NOT EXISTS team_slg_variance FLOAT,   -- season_slg - last_10_slg
    ADD COLUMN IF NOT EXISTS away_slg_delta    FLOAT,   -- away team SLG - home team SLG
    ADD COLUMN IF NOT EXISTS era_xera_gap      FLOAT,   -- opp SP ERA - xERA
    ADD COLUMN IF NOT EXISTS era_fip_gap       FLOAT,   -- opp SP ERA - FIP
    ADD COLUMN IF NOT EXISTS park_adj_total    FLOAT;   -- open_total * park_runs_factor

-- ── pitcher_stats: add xERA and FIP columns if not present ──────────────────
-- (These may already exist depending on your ingestion source; safe no-ops)
ALTER TABLE pitcher_stats
    ADD COLUMN IF NOT EXISTS p_era   FLOAT,
    ADD COLUMN IF NOT EXISTS p_xera  FLOAT,
    ADD COLUMN IF NOT EXISTS p_xfip  FLOAT,
    ADD COLUMN IF NOT EXISTS p_fip   FLOAT;

-- ── Index for fast daily ERA gap lookups ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pitcher_k_games_era_gap
    ON pitcher_k_games (game_id, home_away, date)
    WHERE era_xera_gap IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_run_data_slg
    ON game_run_data (team_id, date DESC);
