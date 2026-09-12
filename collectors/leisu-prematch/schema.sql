-- Dedicated observation storage. This migration never changes football.*.
CREATE SCHEMA IF NOT EXISTS leisu_prematch;

CREATE TABLE IF NOT EXISTS leisu_prematch.scheduler_runs (
  run_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  CHECK (finished_at >= started_at),
  CHECK (payload->>'predictionEligible' = 'false')
);

CREATE TABLE IF NOT EXISTS leisu_prematch.runs (
  run_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL CHECK (length(status) BETWEEN 1 AND 64),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS leisu_prematch.observations (
  observation_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES leisu_prematch.runs(run_id),
  site_match_id text NOT NULL CHECK (length(site_match_id) > 0),
  event_version text NOT NULL CHECK (length(event_version) > 0),
  provider_match_id text NOT NULL CHECK (provider_match_id ~ '^[1-9][0-9]*$'),
  kind text NOT NULL CHECK (kind IN ('injuries', 'lineup')),
  task_key text NOT NULL CHECK (length(task_key) > 0),
  received_at timestamptz NOT NULL,
  source_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'source_empty', 'login_required', 'blocked', 'parse_error', 'conflict')),
  payload jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((status = 'available' AND payload IS NOT NULL) OR (status <> 'available' AND payload IS NULL)),
  UNIQUE (run_id, task_key, kind),
  UNIQUE (observation_id, site_match_id, event_version, kind)
);

CREATE TABLE IF NOT EXISTS leisu_prematch.latest_valid (
  site_match_id text NOT NULL,
  event_version text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('injuries', 'lineup')),
  observation_id uuid NOT NULL,
  PRIMARY KEY (site_match_id, event_version, kind),
  FOREIGN KEY (observation_id, site_match_id, event_version, kind)
    REFERENCES leisu_prematch.observations(observation_id, site_match_id, event_version, kind)
);

CREATE INDEX IF NOT EXISTS observations_identity_received
  ON leisu_prematch.observations (site_match_id, event_version, kind, received_at DESC, observation_id DESC);
CREATE INDEX IF NOT EXISTS observations_task_received
  ON leisu_prematch.observations (task_key, received_at DESC);
CREATE INDEX IF NOT EXISTS observations_received
  ON leisu_prematch.observations (received_at DESC);
