-- Migration: add_model_predictions_june3_cols
-- June 5, 2026 — adds columns required by June 3 post-mortem patch
-- Run once against your Supabase/PostgreSQL instance.

-- HIGH_VARIANCE flag: set when model total is within 0.5 runs of market line
ALTER TABLE model_predictions
    ADD COLUMN IF NOT EXISTS high_variance BOOLEAN NOT NULL DEFAULT FALSE;

-- road_run_diff_last5 column in team_momentum for road blowout defense rule
ALTER TABLE team_momentum
    ADD COLUMN IF NOT EXISTS road_run_diff_last5 NUMERIC(6,2) NOT NULL DEFAULT 0.0;

COMMENT ON COLUMN model_predictions.high_variance IS
    'TRUE when model projected total is within 0.5 runs of market line. Stake capped at 0.5% and parlay inclusion blocked.';

COMMENT ON COLUMN team_momentum.road_run_diff_last5 IS
    'Average run differential over last 5 road games. Used by road blowout defense rule in compute_edges.py.';

CREATE INDEX IF NOT EXISTS idx_model_predictions_high_variance
    ON model_predictions (high_variance)
    WHERE high_variance = TRUE;
