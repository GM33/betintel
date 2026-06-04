-- Migration 006: market_snapshots + market_snapshots_deltas
-- Rank 5: line movement snapshot tables

CREATE TABLE IF NOT EXISTS mlb.market_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    game_id         TEXT NOT NULL,
    market_type     TEXT NOT NULL,
    outcome_label   TEXT NOT NULL,
    bookmaker       TEXT NOT NULL,
    line            NUMERIC,
    prob            NUMERIC,
    snapped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, market_type, outcome_label, bookmaker, snapped_at)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_game
    ON mlb.market_snapshots (game_id, market_type, snapped_at DESC);

-- Materialized/computed view: open vs current delta per outcome
CREATE TABLE IF NOT EXISTS mlb.market_snapshots_deltas (
    id              BIGSERIAL PRIMARY KEY,
    game_id         TEXT NOT NULL,
    market_type     TEXT NOT NULL,
    outcome_label   TEXT NOT NULL,
    bookmaker       TEXT NOT NULL,
    open_line       NUMERIC,
    current_line    NUMERIC,
    delta_pct       NUMERIC,   -- (current_line - open_line) / ABS(open_line)
    open_prob       NUMERIC,
    current_prob    NUMERIC,
    prob_delta      NUMERIC,   -- current_prob - open_prob
    snapped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_deltas_game
    ON mlb.market_snapshots_deltas (game_id, market_type, snapped_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_deltas_delta
    ON mlb.market_snapshots_deltas (ABS(delta_pct) DESC)
    WHERE delta_pct IS NOT NULL;
