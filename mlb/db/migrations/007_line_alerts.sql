-- Migration 007: line_alerts table
-- Rank 5: stores triggered line movement and EV edge alerts

CREATE TABLE IF NOT EXISTS mlb.line_alerts (
    id              BIGSERIAL PRIMARY KEY,
    game_id         TEXT NOT NULL,
    market_type     TEXT NOT NULL,
    outcome_label   TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- 'LINE_MOVE' | 'EV_EDGE'
    severity        TEXT NOT NULL,   -- 'HIGH' | 'MEDIUM' | 'LOW'
    delta_pct       NUMERIC,         -- line delta % that triggered
    ev_delta        NUMERIC,         -- model_prob - market_prob
    model_prob      NUMERIC,
    market_prob     NUMERIC,
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,     -- NULL = still active
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_line_alerts_game
    ON mlb.line_alerts (game_id, market_type, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_line_alerts_active
    ON mlb.line_alerts (severity, triggered_at DESC)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_line_alerts_type
    ON mlb.line_alerts (alert_type, severity, triggered_at DESC);
