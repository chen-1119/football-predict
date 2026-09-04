CREATE SCHEMA IF NOT EXISTS football;

CREATE TABLE IF NOT EXISTS football.schema_migrations (
  version text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS football.publications (
  publication_id text PRIMARY KEY,
  generation_id text NOT NULL,
  manifest_hash text NOT NULL,
  source_cycle_id text,
  state text NOT NULL CHECK (state IN ('candidate', 'current', 'previous', 'rejected')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (generation_id, manifest_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS publications_single_current
  ON football.publications (state)
  WHERE state = 'current';

CREATE TABLE IF NOT EXISTS football.source_snapshots (
  id text PRIMARY KEY,
  source text NOT NULL,
  captured_at timestamptz,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS football.match_snapshots (
  id text PRIMARY KEY,
  dataset text NOT NULL,
  match_id text,
  source_match_id text,
  kickoff_time timestamptz,
  status text,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS match_snapshots_match_id
  ON football.match_snapshots (match_id);
CREATE INDEX IF NOT EXISTS match_snapshots_source_match_id
  ON football.match_snapshots (source_match_id);
CREATE INDEX IF NOT EXISTS match_snapshots_dataset_kickoff
  ON football.match_snapshots (dataset, kickoff_time DESC, match_id);

CREATE TABLE IF NOT EXISTS football.odds_snapshots (
  id text PRIMARY KEY,
  state_key text UNIQUE,
  match_id text,
  source_match_id text,
  pool text,
  bookmaker text,
  handicap_line double precision,
  captured_at timestamptz,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS odds_snapshots_match_id
  ON football.odds_snapshots (match_id);
CREATE INDEX IF NOT EXISTS odds_snapshots_source_pool_time
  ON football.odds_snapshots (source_match_id, pool, captured_at DESC);
CREATE INDEX IF NOT EXISTS odds_snapshots_last_seen
  ON football.odds_snapshots (last_seen_at DESC, id);

CREATE TABLE IF NOT EXISTS football.prediction_snapshots (
  id text PRIMARY KEY,
  state_key text UNIQUE,
  match_id text,
  source_match_id text,
  phase text,
  captured_at timestamptz,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS prediction_snapshots_match_id
  ON football.prediction_snapshots (match_id);
CREATE INDEX IF NOT EXISTS prediction_snapshots_source_phase_time
  ON football.prediction_snapshots (source_match_id, phase, captured_at DESC);
CREATE INDEX IF NOT EXISTS prediction_snapshots_last_seen
  ON football.prediction_snapshots (last_seen_at DESC, id);

CREATE TABLE IF NOT EXISTS football.frozen_recommendations (
  decision_id text PRIMARY KEY,
  match_id text NOT NULL,
  publication_id text REFERENCES football.publications(publication_id),
  track text NOT NULL,
  market text NOT NULL,
  direction text NOT NULL,
  odds numeric(12, 4),
  evidence_score numeric(8, 4),
  frozen_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  decision_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  CHECK (frozen_at <= cutoff_at)
);

CREATE INDEX IF NOT EXISTS frozen_recommendations_match_time
  ON football.frozen_recommendations (match_id, frozen_at DESC);

CREATE TABLE IF NOT EXISTS football.result_observations (
  observation_id text PRIMARY KEY,
  match_id text NOT NULL,
  result_identity text NOT NULL,
  observed_at timestamptz NOT NULL,
  is_official_final boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  UNIQUE (match_id, result_identity)
);

CREATE TABLE IF NOT EXISTS football.post_match_reviews (
  review_id text PRIMARY KEY,
  match_id text NOT NULL,
  decision_id text REFERENCES football.frozen_recommendations(decision_id),
  observation_id text REFERENCES football.result_observations(observation_id),
  settlement text NOT NULL CHECK (settlement IN ('won', 'lost', 'void', 'result-only')),
  formal_hit boolean,
  review_reason text NOT NULL,
  adjustment text NOT NULL,
  settled_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (match_id, decision_id)
);

CREATE INDEX IF NOT EXISTS post_match_reviews_settled_at
  ON football.post_match_reviews (settled_at DESC, match_id);

CREATE TABLE IF NOT EXISTS football.formal_review_daily (
  business_date date PRIMARY KEY,
  won integer NOT NULL DEFAULT 0 CHECK (won >= 0),
  lost integer NOT NULL DEFAULT 0 CHECK (lost >= 0),
  settled integer GENERATED ALWAYS AS (won + lost) STORED,
  hit_rate numeric(8, 6) GENERATED ALWAYS AS (
    CASE WHEN won + lost = 0 THEN NULL ELSE won::numeric / (won + lost) END
  ) STORED,
  source_revision text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS football.ai_competitors (
  competitor_id text PRIMARY KEY,
  display_name text NOT NULL,
  strategy_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS football.ai_decisions (
  decision_id text PRIMARY KEY,
  competition_id text NOT NULL,
  competitor_id text NOT NULL REFERENCES football.ai_competitors(competitor_id),
  match_id text NOT NULL,
  direction text NOT NULL,
  confidence numeric(8, 6) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  stake integer NOT NULL CHECK (stake >= 0),
  risk_tier text NOT NULL CHECK (risk_tier IN ('skip', 'low', 'medium', 'high')),
  decision_hash text NOT NULL UNIQUE,
  decided_at timestamptz NOT NULL,
  locked_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (competition_id, competitor_id, match_id),
  CHECK (decided_at <= locked_at),
  CHECK ((risk_tier = 'skip' AND stake = 0) OR risk_tier <> 'skip')
);

CREATE TABLE IF NOT EXISTS football.ai_score_ledger (
  entry_id text PRIMARY KEY,
  competition_id text NOT NULL,
  competitor_id text NOT NULL REFERENCES football.ai_competitors(competitor_id),
  decision_id text REFERENCES football.ai_decisions(decision_id),
  idempotency_key text NOT NULL UNIQUE,
  delta integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ai_score_ledger_competitor_time
  ON football.ai_score_ledger (competition_id, competitor_id, created_at, entry_id);
