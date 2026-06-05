-- ─────────────────────────────────────────────────────────────────
-- BetIntel: model_divergence table
-- Stores per-market tri-model comparison rows written by
-- divergence/compute_divergence.py
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_divergence (
    id                  SERIAL PRIMARY KEY,
    run_date            DATE        NOT NULL DEFAULT CURRENT_DATE,
    sport               TEXT        NOT NULL,           -- 'wnba' | 'nba'
    game_id             TEXT        NOT NULL,
    player_id           TEXT,                           -- NULL for game markets
    player_name         TEXT,
    market_type         TEXT        NOT NULL,           -- 'player_prop' | 'game'
    prop_type           TEXT        NOT NULL,
    line                NUMERIC(6,1),

    -- ── BetIntel (Poisson) ──────────────────────────────────────
    betintel_p_over     NUMERIC(6,4),
    betintel_p_under    NUMERIC(6,4),
    betintel_edge_over  NUMERIC(6,4),
    betintel_edge_under NUMERIC(6,4),
    betintel_mu         NUMERIC(8,3),

    -- ── Massey Rating Implied Probability ───────────────────────
    massey_p_over       NUMERIC(6,4),
    massey_p_under      NUMERIC(6,4),
    massey_rating_home  NUMERIC(8,4),
    massey_rating_away  NUMERIC(8,4),

    -- ── Elo Win Probability ──────────────────────────────────────
    elo_p_home          NUMERIC(6,4),
    elo_p_away          NUMERIC(6,4),
    elo_rating_home     NUMERIC(8,2),
    elo_rating_away     NUMERIC(8,2),

    -- ── Divergence Metrics ───────────────────────────────────────
    divergence_betintel_massey  NUMERIC(6,4),   -- |betintel_p_over - massey_p_over|
    divergence_betintel_elo     NUMERIC(6,4),   -- |betintel_p_over - elo_p_home|
    divergence_massey_elo       NUMERIC(6,4),   -- |massey_p_over   - elo_p_home|
    max_divergence              NUMERIC(6,4),   -- max of the three above
    consensus_p_over            NUMERIC(6,4),   -- simple average of three models
    consensus_edge              NUMERIC(6,4),   -- consensus_p_over - mkt_implied_over

    -- ── Market ───────────────────────────────────────────────────
    mkt_implied_over    NUMERIC(6,4),
    over_odds           INTEGER,
    under_odds          INTEGER,

    -- ── Decision ─────────────────────────────────────────────────
    flag                TEXT,                   -- 'HIGH_DIVERGE' | 'CONSENSUS_EDGE' | 'NOISE'
    card_recommendation TEXT,                   -- 'BET_OVER' | 'BET_UNDER' | 'PASS'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (run_date, sport, game_id, COALESCE(player_id,''), prop_type)
);

CREATE INDEX IF NOT EXISTS idx_divergence_rundate  ON model_divergence (run_date);
CREATE INDEX IF NOT EXISTS idx_divergence_sport    ON model_divergence (sport);
CREATE INDEX IF NOT EXISTS idx_divergence_flag     ON model_divergence (flag);
