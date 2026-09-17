-- Prospective publications are independent from model-validation qualifications.
-- No legacy recommendation is backfilled by this migration.
CREATE TABLE football.published_forecasts (
  id text PRIMARY KEY,
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  market text NOT NULL CHECK (market = 'HAD'),
  business_date date NOT NULL,
  published_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (source_match_id, event_version, market),
  CHECK (published_at < cutoff_at),
  CHECK (published_at < event_version),
  CHECK ((payload->>'id') IS NOT DISTINCT FROM id),
  CHECK ((payload->>'recordHash') IS NOT DISTINCT FROM record_hash),
  CHECK ((payload->>'statisticsTrack') IS NOT DISTINCT FROM 'published-forecast'),
  CHECK ((payload->>'modelValidation') IS NOT DISTINCT FROM 'unvalidated'),
  CHECK (payload ?& ARRAY['tipCode','probabilities','quoteOdds','quoteObservedAt','inputHash','publication'])
);
CREATE INDEX published_forecasts_day ON football.published_forecasts(business_date DESC, published_at DESC);
CREATE TABLE football.published_forecast_results (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id text PRIMARY KEY,
  forecast_id text NOT NULL REFERENCES football.published_forecasts(id),
  state text NOT NULL CHECK (state IN ('WON','LOST','VOID','DISPUTED')),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX published_forecast_results_latest ON football.published_forecast_results(forecast_id, sequence DESC);
CREATE FUNCTION football.reject_published_forecast_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published forecasts and result events are append-only' USING ERRCODE = '23000';
END;
$$;
CREATE TRIGGER published_forecasts_immutable BEFORE UPDATE OR DELETE ON football.published_forecasts
  FOR EACH ROW EXECUTE FUNCTION football.reject_published_forecast_mutation();
CREATE TRIGGER published_forecast_results_immutable BEFORE UPDATE OR DELETE ON football.published_forecast_results
  FOR EACH ROW EXECUTE FUNCTION football.reject_published_forecast_mutation();
