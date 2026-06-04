-- Migration 004: add calibration_date computed column + unique constraint
-- Fix: use computed_at::date cast (immutable) instead of DATE() function

-- Add calibration_date as a regular column (not generated — avoids immutability error)
ALTER TABLE model_calibration
    ADD COLUMN IF NOT EXISTS calibration_date DATE;

-- Backfill existing rows
UPDATE model_calibration
    SET calibration_date = computed_at::date
    WHERE calibration_date IS NULL;

-- Unique constraint for ON CONFLICT upsert
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_calibration_market_window_date'
    ) THEN
        ALTER TABLE model_calibration
            ADD CONSTRAINT uq_calibration_market_window_date
            UNIQUE (market_type, last_n_days, calibration_date);
    END IF;
END
$$;

-- Index for dashboard queries (latest Brier per market)
CREATE INDEX IF NOT EXISTS idx_calibration_market_date
    ON model_calibration (market_type, calibration_date DESC);

-- Index for drift alert queries
CREATE INDEX IF NOT EXISTS idx_calibration_drift
    ON model_calibration (drift_alert)
    WHERE drift_alert = TRUE;
