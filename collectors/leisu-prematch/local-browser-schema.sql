-- Source receipts in the existing PostgreSQL database. No prediction writes.
CREATE TABLE IF NOT EXISTS leisu_prematch.local_browser_runs (
  run_id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK (summary->>'predictionEligible' = 'false')
);
CREATE TABLE IF NOT EXISTS leisu_prematch.local_browser_observations (
  observation_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES leisu_prematch.local_browser_runs(run_id),
  provider_match_id text NOT NULL CHECK (provider_match_id ~ '^[1-9][0-9]*$'),
  kind text NOT NULL CHECK (kind IN ('injuries','lineup')),
  kickoff_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  source_url text NOT NULL,
  status text NOT NULL,
  payload jsonb,
  reason text,
  prediction_eligible boolean NOT NULL DEFAULT false CHECK (prediction_eligible = false),
  CHECK ((status='available' AND payload IS NOT NULL AND observed_at < kickoff_at)
      OR (status<>'available' AND payload IS NULL)),
  UNIQUE (run_id,provider_match_id,kind)
);
CREATE INDEX IF NOT EXISTS local_browser_match_received
  ON leisu_prematch.local_browser_observations(provider_match_id,kind,observed_at DESC);
