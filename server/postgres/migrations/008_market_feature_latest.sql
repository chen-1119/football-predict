CREATE TABLE IF NOT EXISTS football.market_feature_latest (
  source text NOT NULL,
  source_match_id text NOT NULL,
  pool text NOT NULL,
  bookmaker text NOT NULL,
  kickoff_time timestamptz,
  computed_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size > 0),
  opening_odds jsonb NOT NULL,
  latest_odds jsonb NOT NULL,
  minimum_odds jsonb NOT NULL,
  maximum_odds jsonb NOT NULL,
  absolute_delta jsonb NOT NULL,
  percent_delta jsonb NOT NULL,
  maximum_step jsonb NOT NULL,
  opening_implied jsonb NOT NULL,
  latest_implied jsonb NOT NULL,
  strongest_shortening text CHECK (strongest_shortening IS NULL OR strongest_shortening IN ('1', 'X', '2')),
  reversal_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  movement_score numeric(12, 6) NOT NULL DEFAULT 0 CHECK (movement_score >= 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (source, source_match_id, pool, bookmaker),
  CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS market_feature_latest_kickoff
  ON football.market_feature_latest (kickoff_time, source_match_id, pool);

CREATE INDEX IF NOT EXISTS market_feature_latest_computed
  ON football.market_feature_latest (computed_at DESC, source_match_id, pool);
