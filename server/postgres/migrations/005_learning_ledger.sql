-- Preserve original byte strings and audit clocks; these are not projections
-- that may be regenerated from today's model. Native shadow cycles cannot CAS
-- the active-model pointer or create privileged promotion/rollback events.
CREATE TABLE football.learning_ledger_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE football.learning_model_artifacts (
  artifact_hash text PRIMARY KEY,
  artifact_type text NOT NULL,
  media_type text NOT NULL,
  artifact_bytes bytea NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0 AND byte_length <= 9007199254740991),
  metadata_json text NOT NULL,
  metadata_hash text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE football.learning_events (
  sequence bigint PRIMARY KEY CHECK (sequence > 0 AND sequence <= 9007199254740991),
  cycle_sequence bigint NOT NULL CHECK (cycle_sequence > 0 AND cycle_sequence <= 9007199254740991),
  cycle_id text NOT NULL,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  state text NOT NULL,
  occurred_at text NOT NULL,
  actor_json text NOT NULL,
  payload_json text NOT NULL,
  payload_hash text NOT NULL,
  artifact_hash text REFERENCES football.learning_model_artifacts(artifact_hash),
  previous_event_hash text,
  previous_cycle_event_hash text,
  previous_cycle_state text,
  event_hash text NOT NULL UNIQUE,
  UNIQUE (cycle_id, cycle_sequence)
);
CREATE TABLE football.learning_active_model_pointer (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  generation bigint NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  artifact_hash text REFERENCES football.learning_model_artifacts(artifact_hash),
  previous_artifact_hash text,
  event_hash text REFERENCES football.learning_events(event_hash),
  updated_at text NOT NULL
);
CREATE TABLE football.learning_leases (
  lease_name text PRIMARY KEY,
  holder_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0 AND fencing_token <= 9007199254740991),
  acquired_at text NOT NULL,
  expires_at text NOT NULL
);
