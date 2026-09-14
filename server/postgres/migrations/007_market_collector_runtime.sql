CREATE TABLE IF NOT EXISTS football.market_collector_runs (
  run_id text PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked')),
  rows_seen integer NOT NULL DEFAULT 0 CHECK (rows_seen >= 0),
  rows_changed integer NOT NULL DEFAULT 0 CHECK (rows_changed >= 0),
  rows_unchanged integer NOT NULL DEFAULT 0 CHECK (rows_unchanged >= 0),
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes integer CHECK (source_bytes IS NULL OR source_bytes >= 0),
  next_poll_seconds integer CHECK (next_poll_seconds IS NULL OR next_poll_seconds >= 60),
  error_code text,
  error_message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS market_collector_runs_source_time
  ON football.market_collector_runs (source, started_at DESC);

CREATE TABLE IF NOT EXISTS football.market_observations (
  observation_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES football.market_collector_runs(run_id),
  source text NOT NULL,
  source_match_id text NOT NULL,
  fixture_id text,
  match_no text,
  pool text NOT NULL,
  bookmaker text NOT NULL,
  handicap_line double precision,
  kickoff_time timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS market_observations_match_market_time
  ON football.market_observations
  (source, source_match_id, pool, bookmaker, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS market_observations_kickoff_time
  ON football.market_observations (kickoff_time, source_match_id);

CREATE INDEX IF NOT EXISTS market_observations_last_seen
  ON football.market_observations (last_seen_at DESC, observation_id);

CREATE TABLE IF NOT EXISTS football.market_latest (
  source text NOT NULL,
  source_match_id text NOT NULL,
  pool text NOT NULL,
  bookmaker text NOT NULL,
  observation_id text NOT NULL REFERENCES football.market_observations(observation_id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source, source_match_id, pool, bookmaker)
);

CREATE INDEX IF NOT EXISTS market_latest_updated_at
  ON football.market_latest (updated_at DESC, source_match_id);
