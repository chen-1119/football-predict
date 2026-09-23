-- Prospective, independent research only. No existing publication or
-- settlement rows are changed. The first pre-cutoff record for each event
-- wins; a later input or result cannot rewrite its two frozen selections.
CREATE TABLE football.recommendation_dual_research_records (
  id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES football.recommendation_decisions(id),
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  business_date date NOT NULL,
  recorded_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  UNIQUE(source_match_id,event_version),
  CHECK(recorded_at<cutoff_at AND recorded_at<event_version),
  CHECK(payload->>'id' IS NOT DISTINCT FROM id),
  CHECK(payload->>'decisionId' IS NOT DISTINCT FROM decision_id),
  CHECK(payload->>'cohort' IS NOT DISTINCT FROM 'independent-research-only'),
  CHECK(payload->>'formalPromotion' IS NOT DISTINCT FROM 'false'),
  CHECK((jsonb_array_length(payload->'selections')=2) IS TRUE)
);
CREATE INDEX recommendation_dual_research_day ON football.recommendation_dual_research_records(business_date DESC,recorded_at DESC);
CREATE TRIGGER dual_research_immutable BEFORE UPDATE OR DELETE ON football.recommendation_dual_research_records
  FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
CREATE CONSTRAINT TRIGGER dual_research_deadline AFTER INSERT ON football.recommendation_dual_research_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football.check_recommendation_deadline();
