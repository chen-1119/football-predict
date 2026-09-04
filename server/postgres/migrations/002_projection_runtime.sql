CREATE TABLE IF NOT EXISTS football.projection_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL,
  replicated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS football.projection_runs (
  run_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('backfill', 'incremental', 'fast-result')),
  source_path text NOT NULL,
  source_fingerprint text NOT NULL,
  publication_id text REFERENCES football.publications(publication_id),
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  table_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS projection_runs_committed_at
  ON football.projection_runs (committed_at DESC, run_id);

CREATE TABLE IF NOT EXISTS football.private_model_artifacts (
  artifact_key text PRIMARY KEY,
  artifact_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes integer NOT NULL CHECK (payload_bytes > 0)
);

CREATE INDEX IF NOT EXISTS private_model_artifacts_updated_at
  ON football.private_model_artifacts (updated_at DESC, artifact_key);
