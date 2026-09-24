-- V2 research is bound to a captured pre-match event, not to a HAD decision.
-- Keep the existing v1 ledger and its immutable rows unchanged. The first
-- accepted V2 pair for an event wins; later prices or results cannot rewrite it.
CREATE TABLE football.recommendation_dual_research_v2_records (
  id text PRIMARY KEY,
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  business_date date NOT NULL,
  recorded_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (source_match_id, event_version),
  CHECK (recorded_at < cutoff_at AND recorded_at < event_version),
  CHECK (payload->>'id' IS NOT DISTINCT FROM id),
  CHECK (payload->>'version' IS NOT DISTINCT FROM 'dual-choice-research-v2'),
  CHECK (payload->>'cohort' IS NOT DISTINCT FROM 'independent-research-only'),
  CHECK (payload->>'formalPromotion' IS NOT DISTINCT FROM 'false'),
  CHECK (payload->>'decisionId' IS NULL),
  CHECK (payload->>'sourceMatchId' IS NOT DISTINCT FROM source_match_id),
  CHECK ((payload->>'eventVersion')::timestamptz IS NOT DISTINCT FROM event_version),
  CHECK ((payload->>'businessDate')::date IS NOT DISTINCT FROM business_date),
  CHECK ((payload->>'recordedAt')::timestamptz IS NOT DISTINCT FROM recorded_at),
  CHECK ((payload->>'cutoffAt')::timestamptz IS NOT DISTINCT FROM cutoff_at),
  CHECK (jsonb_typeof(payload->'selections') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_array_length(payload->'selections') IS NOT DISTINCT FROM 2),
  CHECK ((payload->'selections'->0->>'market' IN ('HAD', 'HHAD')
     AND payload->'selections'->1->>'market' IN ('HAD', 'HHAD')) IS TRUE),
  CHECK ((CASE payload->'selections'->0->>'market'
    WHEN 'HAD' THEN payload->'selections'->0->>'handicapLine' = '0'
    WHEN 'HHAD' THEN payload->'selections'->0->>'handicapLine' ~ '^-?[1-9][0-9]*$'
    ELSE false END) IS TRUE),
  CHECK ((CASE payload->'selections'->1->>'market'
    WHEN 'HAD' THEN payload->'selections'->1->>'handicapLine' = '0'
    WHEN 'HHAD' THEN payload->'selections'->1->>'handicapLine' ~ '^-?[1-9][0-9]*$'
    ELSE false END) IS TRUE),
  CHECK ((payload->'selections'->0->>'tipCode' IN ('1', 'X', '2')
     AND payload->'selections'->1->>'tipCode' IN ('1', 'X', '2')
     AND (payload->'selections'->0->>'market' <> payload->'selections'->1->>'market'
       OR (payload->'selections'->0->>'handicapLine' = payload->'selections'->1->>'handicapLine'
         AND payload->'selections'->0->>'tipCode' <> payload->'selections'->1->>'tipCode'))) IS TRUE)
);
CREATE INDEX recommendation_dual_research_v2_day
  ON football.recommendation_dual_research_v2_records (business_date DESC, recorded_at DESC);
CREATE TRIGGER dual_research_v2_immutable
  BEFORE UPDATE OR DELETE ON football.recommendation_dual_research_v2_records
  FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
CREATE CONSTRAINT TRIGGER dual_research_v2_deadline
  AFTER INSERT ON football.recommendation_dual_research_v2_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football.check_recommendation_deadline();
