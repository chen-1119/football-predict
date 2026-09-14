-- Append-only source receipts in the existing football database.
CREATE TABLE IF NOT EXISTS football.prematch_source_runs (
  run_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  provider text NOT NULL CHECK (provider = 'api-football'),
  summary jsonb NOT NULL,
  roster jsonb NOT NULL,
  reference jsonb NOT NULL,
  CHECK (reference->>'predictionEligible' = 'false'),
  CHECK (completed_at >= started_at)
);
CREATE TABLE IF NOT EXISTS football.prematch_source_receipts (
  run_id uuid NOT NULL REFERENCES football.prematch_source_runs(run_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  provider text NOT NULL CHECK (provider IN ('sporttery','api-football')),
  endpoint text NOT NULL,
  received_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  prediction_eligible boolean NOT NULL DEFAULT false CHECK (prediction_eligible = false),
  PRIMARY KEY (run_id, ordinal)
);
CREATE INDEX IF NOT EXISTS prematch_source_runs_time ON football.prematch_source_runs(completed_at DESC);
