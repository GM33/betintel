-- Migration 005: June 3, 2026 BetIntel Model Upgrade
-- Adds xERA gap, bullpen fatigue, park total adjustment, slugging variance,
-- and road underdog confidence flag columns required by the June 3 model recalibration.
-- All columns are nullable so existing rows and queries are unaffected.

-- ─────────────────────────────────────────────────────────────────────────────
-- game_run_data: new feature columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Recent team slugging % (last 14d) for the batting team
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS team_slg_recent FLOAT;

-- Recent opponent slugging % (last 14d)
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS opp_slg_recent FLOAT;

-- Derived SLG delta: team_slg_recent - opp_slg_recent (positive = team has edge)
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS team_slg_delta FLOAT
    GENERATED ALWAYS AS (team_slg_recent - opp_slg_recent) STORED;

-- Opposing SP surface ERA
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS sp_era FLOAT;

-- Opposing SP projected ERA (xFIP or FIP, whichever available)
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS sp_proj_era FLOAT;

-- xERA regression gap: sp_proj_era - sp_era
-- Positive = pitcher is outperforming true skill (regression risk)
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS sp_era_gap FLOAT
    GENERATED ALWAYS AS (sp_proj_era - sp_era) STORED;

-- Bullpen fatigue index: IP by opp bullpen over last 3 days
-- >= 12 triggers fatigue flag in analyst agent
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS bp_fatigue_idx FLOAT;

-- Park total adjustment: park_runs_factor - 1.0
-- Negative = run-suppressing park (e.g. T-Mobile -0.11), positive = hitter-friendly
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS park_total_adjustment FLOAT
    GENERATED ALWAYS AS (park_runs_factor - 1.0) STORED;

-- Road underdog confidence flag
-- 1 = road dog qualifies for elevated signal based on SLG edge or xERA gap rules
ALTER TABLE game_run_data
    ADD COLUMN IF NOT EXISTS underdog_confidence_flag SMALLINT DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- model_predictions: expose new feature signals for analyst agent
-- ─────────────────────────────────────────────────────────────────────────────

-- xERA regression gap passed from game_run_data at prediction time
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS sp_era_gap FLOAT;

-- Bullpen fatigue index at prediction time
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS bp_fatigue_idx FLOAT;

-- Park total adjustment at prediction time
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS park_total_adjustment FLOAT;

-- Road underdog confidence flag at prediction time
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS underdog_confidence_flag SMALLINT DEFAULT 0;

-- SLG delta at prediction time
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS team_slg_delta FLOAT;

-- ─────────────────────────────────────────────────────────────────────────────
-- pitcher_stats: add xFIP and FIP if not already present
-- (used to derive sp_proj_era in build_game_features.py)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pitcher_stats
    ADD COLUMN IF NOT EXISTS era FLOAT;

ALTER TABLE pitcher_stats
    ADD COLUMN IF NOT EXISTS xfip FLOAT;

ALTER TABLE pitcher_stats
    ADD COLUMN IF NOT EXISTS fip FLOAT;

-- ─────────────────────────────────────────────────────────────────────────────
-- team_offense_stats: add slugging % if not already present
-- (used to derive team_slg_recent/opp_slg_recent in build_game_features.py)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE team_offense_stats
    ADD COLUMN IF NOT EXISTS slugging_pct FLOAT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for query performance on new feature columns
-- ─────────────────────────────────────────────────────────────────────────────

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

COMMENT ON COLUMN game_run_data.sp_era_gap IS
    'xERA regression gap: sp_proj_era - sp_era. Values >= 1.5 indicate pitcher is outperforming true skill and is a fade candidate (June 3 rule).';

COMMENT ON COLUMN game_run_data.bp_fatigue_idx IS
    'Opposing bullpen IP over last 3 days. Values >= 12 trigger bullpen fatigue warning in analyst agent (June 3 rule).';

COMMENT ON COLUMN game_run_data.park_total_adjustment IS
    'Park run factor delta from league average (park_runs_factor - 1.0). Negative = suppressor park; positive = hitter-friendly (June 3 rule).';

COMMENT ON COLUMN game_run_data.underdog_confidence_flag IS
    'Road dog qualifies for elevated signal: SLG delta >= 0.015 or sp_era_gap >= 1.5 when is_home=0 (June 3 rule).';
