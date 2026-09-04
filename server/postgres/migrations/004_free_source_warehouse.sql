CREATE TABLE IF NOT EXISTS football.data_sources (
  source_key text PRIMARY KEY,
  display_name text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('official', 'community', 'research', 'aggregated')),
  source_url text NOT NULL,
  license_code text NOT NULL,
  authority_rank integer NOT NULL CHECK (authority_rank BETWEEN 0 AND 100),
  refresh_interval_minutes integer CHECK (refresh_interval_minutes IS NULL OR refresh_interval_minutes > 0),
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS football.data_ingest_runs (
  run_id text PRIMARY KEY,
  source_key text NOT NULL REFERENCES football.data_sources(source_key),
  source_file_path text,
  source_file_sha256 text NOT NULL CHECK (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'duplicate', 'failed', 'blocked')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  input_rows integer NOT NULL DEFAULT 0 CHECK (input_rows >= 0),
  accepted_rows integer NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  duplicate_rows integer NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  rejected_rows integer NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  conflict_rows integer NOT NULL DEFAULT 0 CHECK (conflict_rows >= 0),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text
);

CREATE UNIQUE INDEX IF NOT EXISTS data_ingest_runs_completed_file
  ON football.data_ingest_runs (source_key, source_file_sha256)
  WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS data_ingest_runs_source_time
  ON football.data_ingest_runs (source_key, started_at DESC);

CREATE TABLE IF NOT EXISTS football.historical_teams (
  team_id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('club', 'international')),
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  first_seen_date date,
  last_seen_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, normalized_name)
);

CREATE TABLE IF NOT EXISTS football.historical_team_aliases (
  source_key text NOT NULL REFERENCES football.data_sources(source_key),
  normalized_alias text NOT NULL,
  raw_alias text NOT NULL,
  team_id text NOT NULL REFERENCES football.historical_teams(team_id),
  confidence numeric(6, 5) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  mapping_status text NOT NULL DEFAULT 'exact' CHECK (mapping_status IN ('exact', 'verified', 'candidate', 'conflict')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key, normalized_alias)
);

CREATE INDEX IF NOT EXISTS historical_team_aliases_team
  ON football.historical_team_aliases (team_id, source_key);

CREATE TABLE IF NOT EXISTS football.historical_competitions (
  competition_id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('club', 'international')),
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, normalized_name)
);

CREATE TABLE IF NOT EXISTS football.historical_matches (
  match_id text PRIMARY KEY,
  canonical_key text NOT NULL UNIQUE,
  competition_id text NOT NULL REFERENCES football.historical_competitions(competition_id),
  match_date date NOT NULL,
  kickoff_time timestamptz,
  kickoff_local_time time,
  home_team_id text NOT NULL REFERENCES football.historical_teams(team_id),
  away_team_id text NOT NULL REFERENCES football.historical_teams(team_id),
  neutral boolean,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id)
);

CREATE INDEX IF NOT EXISTS historical_matches_date
  ON football.historical_matches (match_date DESC, match_id);
CREATE INDEX IF NOT EXISTS historical_matches_home_date
  ON football.historical_matches (home_team_id, match_date DESC);
CREATE INDEX IF NOT EXISTS historical_matches_away_date
  ON football.historical_matches (away_team_id, match_date DESC);

CREATE TABLE IF NOT EXISTS football.historical_source_events (
  source_key text NOT NULL REFERENCES football.data_sources(source_key),
  source_event_id text NOT NULL,
  match_id text NOT NULL REFERENCES football.historical_matches(match_id),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  raw_row_sha256 text CHECK (raw_row_sha256 IS NULL OR raw_row_sha256 ~ '^[0-9a-f]{64}$'),
  source_row_number integer CHECK (source_row_number IS NULL OR source_row_number > 0),
  ingest_run_id text NOT NULL REFERENCES football.data_ingest_runs(run_id),
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key, source_event_id)
);

CREATE INDEX IF NOT EXISTS historical_source_events_match
  ON football.historical_source_events (match_id, source_key);
CREATE INDEX IF NOT EXISTS historical_source_events_run
  ON football.historical_source_events (ingest_run_id, source_event_id);

CREATE TABLE IF NOT EXISTS football.historical_result_observations (
  observation_id text PRIMARY KEY,
  match_id text NOT NULL REFERENCES football.historical_matches(match_id),
  source_key text NOT NULL,
  source_event_id text NOT NULL,
  home_goals integer NOT NULL CHECK (home_goals >= 0),
  away_goals integer NOT NULL CHECK (away_goals >= 0),
  outcome text NOT NULL CHECK (outcome IN ('H', 'D', 'A')),
  available_at timestamptz NOT NULL,
  availability_policy text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_key, source_event_id)
    REFERENCES football.historical_source_events(source_key, source_event_id),
  UNIQUE (source_key, source_event_id)
);

CREATE INDEX IF NOT EXISTS historical_result_observations_match
  ON football.historical_result_observations (match_id, available_at DESC);

CREATE TABLE IF NOT EXISTS football.historical_odds_observations (
  observation_id text PRIMARY KEY,
  match_id text NOT NULL REFERENCES football.historical_matches(match_id),
  source_key text NOT NULL,
  source_event_id text NOT NULL,
  market text NOT NULL DEFAULT 'HAD' CHECK (market = 'HAD'),
  home_odds numeric(12, 4) NOT NULL CHECK (home_odds > 1),
  draw_odds numeric(12, 4) NOT NULL CHECK (draw_odds > 1),
  away_odds numeric(12, 4) NOT NULL CHECK (away_odds > 1),
  timing_class text NOT NULL DEFAULT 'historical-pre-match-unspecified',
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_key, source_event_id)
    REFERENCES football.historical_source_events(source_key, source_event_id),
  UNIQUE (source_key, source_event_id, market)
);

CREATE INDEX IF NOT EXISTS historical_odds_observations_match
  ON football.historical_odds_observations (match_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS football.historical_feature_snapshots (
  feature_id text PRIMARY KEY,
  match_id text NOT NULL REFERENCES football.historical_matches(match_id),
  feature_version text NOT NULL,
  as_of timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, feature_version, as_of)
);

CREATE INDEX IF NOT EXISTS historical_feature_snapshots_asof
  ON football.historical_feature_snapshots (as_of DESC, match_id);

CREATE TABLE IF NOT EXISTS football.data_source_conflicts (
  conflict_id text PRIMARY KEY,
  match_id text REFERENCES football.historical_matches(match_id),
  conflict_type text NOT NULL,
  source_keys text[] NOT NULL,
  payload jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);

CREATE INDEX IF NOT EXISTS data_source_conflicts_unresolved
  ON football.data_source_conflicts (detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE OR REPLACE VIEW football.historical_resolved_results AS
SELECT DISTINCT ON (observation.match_id)
  observation.match_id,
  observation.home_goals,
  observation.away_goals,
  observation.outcome,
  observation.source_key,
  observation.source_event_id,
  observation.available_at,
  source.authority_rank
FROM football.historical_result_observations observation
JOIN football.data_sources source USING (source_key)
WHERE source.enabled = true
ORDER BY observation.match_id, source.authority_rank DESC, observation.available_at DESC,
  observation.observation_id DESC;
