-- Opaque payloads participate in immutable recommendation, feature snapshot,
-- decision, and artifact hashes. PostgreSQL jsonb reorders object keys during
-- storage, so these columns must retain the source JSON text order.

ALTER TABLE football.publications
  ALTER COLUMN payload DROP DEFAULT,
  ALTER COLUMN payload TYPE json USING payload::text::json,
  ALTER COLUMN payload SET DEFAULT '{}'::json;

ALTER TABLE football.source_snapshots
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.match_snapshots
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.odds_snapshots
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.prediction_snapshots
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.frozen_recommendations
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.result_observations
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.post_match_reviews
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.ai_decisions
  ALTER COLUMN payload TYPE json USING payload::text::json;

ALTER TABLE football.ai_score_ledger
  ALTER COLUMN payload DROP DEFAULT,
  ALTER COLUMN payload TYPE json USING payload::text::json,
  ALTER COLUMN payload SET DEFAULT '{}'::json;

ALTER TABLE football.private_model_artifacts
  ALTER COLUMN payload TYPE json USING payload::text::json;
