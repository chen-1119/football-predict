-- Unverified research receipts are deliberately isolated from match/results,
-- predictions and official evidence. Original raw bytes and receipt JSON are
-- immutable audit material; a later fetch cannot refresh first_received_at.
CREATE TABLE football.research_observation_meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE football.research_source_contents (
  source_url text NOT NULL,
  content_hash text NOT NULL,
  raw bytea NOT NULL,
  first_received_at text NOT NULL,
  first_receipt_hash text NOT NULL,
  PRIMARY KEY (source_url,content_hash)
);
CREATE TABLE football.research_observations (
  sequence integer PRIMARY KEY CHECK (sequence > 0 AND sequence <= 20000),
  source_url text NOT NULL,
  content_hash text NOT NULL,
  received_at text NOT NULL,
  receipt_json text NOT NULL,
  receipt_hash text NOT NULL UNIQUE,
  FOREIGN KEY (source_url,content_hash) REFERENCES football.research_source_contents(source_url,content_hash)
);
CREATE INDEX research_observations_source ON football.research_observations(source_url,sequence);
