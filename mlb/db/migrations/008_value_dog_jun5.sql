-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008 — VALUE_DOG rule support (June 5, 2026)
-- Adds:
--   1. model_predictions.value_dog         — flags picks where VALUE_DOG fired
--   2. team_season_stats.wrc_plus_rank      — away team offensive rank gate
--   3. team_season_stats.season_run_diff    — home team weakness gate
-- Run once against Supabase before June 6 pipeline.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. model_predictions: track which picks were boosted by VALUE_DOG
ALTER TABLE model_predictions
  ADD COLUMN IF NOT EXISTS value_dog BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN model_predictions.value_dog IS
  'TRUE when VALUE_DOG rule fired: away team +120 or better, home RD <= +20, away wRC+ rank <= 15. Enables isolated backtracking of the rule performance.';

-- 2. team_season_stats: wRC+ rank (1 = best offense in MLB, populated daily by ingestion)
ALTER TABLE team_season_stats
  ADD COLUMN IF NOT EXISTS wrc_plus_rank INTEGER;

COMMENT ON COLUMN team_season_stats.wrc_plus_rank IS
  'Team wRC+ rank for the season (1 = best). Pulled from FanGraphs team wRC+ daily. Used by VALUE_DOG rule to floor out offensively weak road dogs.';

-- 3. team_season_stats: season run differential (may already exist — idempotent)
ALTER TABLE team_season_stats
  ADD COLUMN IF NOT EXISTS season_run_diff NUMERIC;

COMMENT ON COLUMN team_season_stats.season_run_diff IS
  'Season-to-date run differential for the team. Used by VALUE_DOG to identify weak home chalk (RD <= +20).';

-- Index to make VALUE_DOG lookups fast (team + season join)
CREATE INDEX IF NOT EXISTS idx_team_season_stats_team_season
  ON team_season_stats (team_id, season);

-- Index to filter value_dog picks quickly in dashboard queries
CREATE INDEX IF NOT EXISTS idx_model_predictions_value_dog
  ON model_predictions (value_dog)
  WHERE value_dog = TRUE;

-- Backfill today's picks that would have qualified (CIN @ STL June 5 reference)
-- Run manually after ingestion populates wrc_plus_rank if needed:
-- UPDATE model_predictions SET value_dog = TRUE
-- WHERE DATE(created_at) = '2026-06-05'
--   AND away_odds >= 120
--   AND card_decision IN ('CANDIDATE', 'LEAN');
