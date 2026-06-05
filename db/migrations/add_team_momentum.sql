-- Migration: add_team_momentum
-- June 5, 2026 — supports momentum delta layer in compute_edges.py
-- Run once against your Supabase/PostgreSQL instance.

CREATE TABLE IF NOT EXISTS team_momentum (
    id             SERIAL PRIMARY KEY,
    team_id        INTEGER NOT NULL,
    date           DATE    NOT NULL,
    run_diff_last5 NUMERIC(6,2) NOT NULL DEFAULT 0.0,
    games_played   INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, date)
);

CREATE INDEX IF NOT EXISTS idx_team_momentum_team_date
    ON team_momentum (team_id, date DESC);

COMMENT ON TABLE team_momentum IS
    'Last-5-game run differential per team per date. Populated by mlb/ingestion/team_momentum.py. Used by compute_edges.py MOMENTUM_WEIGHT layer.';
