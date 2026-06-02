-- Edge alert log: fires when market line deviates >= threshold from model fair prob
CREATE TABLE IF NOT EXISTS edge_alerts (
    id SERIAL PRIMARY KEY,

    -- Game / market context
    game_id          VARCHAR NOT NULL,
    player_id        INT,
    player_name      VARCHAR,
    market_type      VARCHAR NOT NULL,   -- 'game_total' | 'moneyline' | 'k_prop'
    prop_side        VARCHAR NOT NULL,   -- 'over' | 'under' | 'home' | 'away'

    -- Model snapshot at trigger time
    model_prob       FLOAT NOT NULL,     -- e.g. 0.68
    model_mean       FLOAT,              -- projected runs or Ks
    model_line       FLOAT,              -- model's fair line

    -- Market snapshot at trigger time
    market_line      FLOAT NOT NULL,     -- bookmaker line
    market_odds_dk   INT,
    market_odds_fd   INT,
    market_implied   FLOAT NOT NULL,     -- implied prob from best odds

    -- Edge metrics
    edge_pct         FLOAT NOT NULL,     -- model_prob - market_implied
    edge_threshold   FLOAT NOT NULL DEFAULT 0.05,

    -- Context flags (re-query from game_context at alert time)
    lineup_confirmed   BOOLEAN,
    sp_confirmed       BOOLEAN,
    injury_flag        BOOLEAN DEFAULT FALSE,
    injury_note        VARCHAR,

    -- Alert lifecycle
    alert_status     VARCHAR NOT NULL DEFAULT 'ACTIVE',  -- 'ACTIVE' | 'EXPIRED' | 'RESOLVED'
    triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ,        -- game start time; alert irrelevant after this
    resolved_at      TIMESTAMPTZ,
    resolution_note  VARCHAR             -- e.g. 'line moved to 8.5, edge closed'
);

CREATE INDEX IF NOT EXISTS idx_edge_alerts_game_date
    ON edge_alerts (game_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_alerts_status
    ON edge_alerts (alert_status, triggered_at DESC);

COMMENT ON TABLE edge_alerts IS
    'Rolling log of every triggered edge where market line deviates >= threshold from model fair prob.';
