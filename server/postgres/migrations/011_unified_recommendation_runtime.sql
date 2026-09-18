-- New cohort only. Existing recommendation and combo payloads are never rewritten.
CREATE TABLE football.recommendation_decisions (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id text PRIMARY KEY,
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  business_date date NOT NULL,
  published_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  UNIQUE(source_match_id,event_version,input_hash),
  CHECK(published_at<cutoff_at AND published_at<event_version),
  CHECK(payload->>'decisionId' IS NOT DISTINCT FROM id),
  CHECK(payload->>'market' IS NOT DISTINCT FROM 'HAD')
);
CREATE INDEX recommendation_decisions_event ON football.recommendation_decisions(source_match_id,event_version,sequence DESC);
CREATE INDEX recommendation_decisions_day ON football.recommendation_decisions(business_date,sequence DESC);
CREATE TABLE football.recommendation_combo_records (
  id text PRIMARY KEY,
  business_date date NOT NULL,
  size integer NOT NULL CHECK(size IN (2,3)),
  frozen_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(business_date,size),
  CHECK(frozen_at<cutoff_at),
  CHECK(payload->>'id' IS NOT DISTINCT FROM id),
  CHECK(((payload->>'size')::integer=size) IS TRUE),
  CHECK((jsonb_array_length(payload->'legs')=size) IS TRUE),
  CHECK((jsonb_array_length(payload->'decisionIds')=size) IS TRUE)
);
CREATE TABLE football.recommendation_combo_legs (
  combo_id text NOT NULL REFERENCES football.recommendation_combo_records(id),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
  decision_id text NOT NULL REFERENCES football.recommendation_decisions(id),
  PRIMARY KEY(combo_id,ordinal), UNIQUE(combo_id,decision_id)
);
CREATE TABLE football.recommendation_result_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id text PRIMARY KEY,
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX recommendation_results_event ON football.recommendation_result_events(source_match_id,event_version,sequence DESC);
CREATE TABLE football.recommendation_result_heads (
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  event_id text NOT NULL REFERENCES football.recommendation_result_events(id),
  PRIMARY KEY(source_match_id,event_version)
);
CREATE TABLE football.recommendation_lanes (
  lane text PRIMARY KEY CHECK(lane IN ('publish','combos','settlement','view')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL
);
CREATE TABLE football.recommendation_issues (
  id text PRIMARY KEY,
  lane text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  occurrences integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL
);
-- Durable wake counter: notifications are hints; workers also poll this row.
CREATE TABLE football.recommendation_input_clock (
  id integer PRIMARY KEY CHECK(id=1),
  revision bigint NOT NULL DEFAULT 0,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO football.recommendation_input_clock(id) VALUES(1);
CREATE FUNCTION football.wake_recommendation_workers() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.key IN ('data_generation_id','manifest_hash','source_cycle_id','fast_result_revision')
     AND (TG_OP='INSERT' OR NEW.value IS DISTINCT FROM OLD.value) THEN
    UPDATE football.recommendation_input_clock SET revision=revision+1,changed_at=clock_timestamp() WHERE id=1;
    PERFORM pg_notify('football_recommendation_input', 'changed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER recommendation_input_changed AFTER INSERT OR UPDATE ON football.projection_meta
  FOR EACH ROW EXECUTE FUNCTION football.wake_recommendation_workers();
CREATE FUNCTION football.reject_recommendation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recommendation records are append-only' USING ERRCODE='23000'; END;
$$;
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON football.recommendation_decisions FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
CREATE TRIGGER combo_immutable BEFORE UPDATE OR DELETE ON football.recommendation_combo_records FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
CREATE TRIGGER combo_leg_immutable BEFORE UPDATE OR DELETE ON football.recommendation_combo_legs FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
CREATE TRIGGER result_event_immutable BEFORE UPDATE OR DELETE ON football.recommendation_result_events FOR EACH ROW EXECUTE FUNCTION football.reject_recommendation_mutation();
-- Recheck on the database clock at transaction end, not only when a task starts.
CREATE FUNCTION football.check_recommendation_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF clock_timestamp() >= NEW.cutoff_at THEN RAISE EXCEPTION 'Recommendation deadline crossed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER decision_deadline AFTER INSERT ON football.recommendation_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football.check_recommendation_deadline();
CREATE CONSTRAINT TRIGGER combo_deadline AFTER INSERT ON football.recommendation_combo_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football.check_recommendation_deadline();
