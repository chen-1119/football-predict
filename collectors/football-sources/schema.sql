-- Independent additive schema: never rewrite official fixtures or frozen picks.
CREATE SCHEMA IF NOT EXISTS football_sources;
CREATE TABLE IF NOT EXISTS football_sources.raw_receipts (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'), provider text NOT NULL,
  received_at timestamptz NOT NULL, raw_body text NOT NULL
);
CREATE TABLE IF NOT EXISTS football_sources.cache (
  key text PRIMARY KEY, provider text NOT NULL, received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS football_sources_cache_expiry ON football_sources.cache(expires_at);
CREATE TABLE IF NOT EXISTS football_sources.quota (
  provider text PRIMARY KEY, utc_day date NOT NULL, used integer NOT NULL CHECK(used>=0), next_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS football_sources.attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, provider text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL, state text NOT NULL
);
CREATE INDEX IF NOT EXISTS football_sources_attempt_time ON football_sources.attempts(provider,finished_at DESC);
CREATE TABLE IF NOT EXISTS football_sources.match_views (
  match_id text PRIMARY KEY, event_version timestamptz NOT NULL, input_hash text NOT NULL,
  checked_at timestamptz NOT NULL, payload jsonb NOT NULL
);
