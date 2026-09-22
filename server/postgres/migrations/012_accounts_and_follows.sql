-- Identity and personal data are separate from immutable public recommendations.
CREATE TABLE football.account_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  password_hash text NOT NULL,
  recovery_hash text NOT NULL CHECK (recovery_hash ~ '^[a-f0-9]{64}$'),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','operator','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  trial_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE football.account_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES football.account_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX account_sessions_user ON football.account_sessions(user_id,created_at DESC);
CREATE TABLE football.account_access_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES football.account_users(id),
  kind text NOT NULL CHECK (kind IN ('trial','legacy-code','manual')),
  source_key text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(kind,source_key),
  CHECK (expires_at > starts_at)
);
CREATE UNIQUE INDEX account_trial_once ON football.account_access_grants(user_id) WHERE kind='trial';
CREATE INDEX account_access_user ON football.account_access_grants(user_id,expires_at DESC);
CREATE TABLE football.account_legacy_redemptions (
  code_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES football.account_users(id),
  grant_id uuid NOT NULL UNIQUE REFERENCES football.account_access_grants(id),
  redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE football.account_follows (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES football.account_users(id),
  match_id text NOT NULL,
  source_match_id text NOT NULL,
  event_version timestamptz NOT NULL,
  home_team_name text NOT NULL,
  away_team_name text NOT NULL,
  kickoff_at timestamptz NOT NULL,
  decision_id text,
  decision_record_hash text,
  decision_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,source_match_id,event_version),
  CHECK ((decision_id IS NULL AND decision_record_hash IS NULL AND decision_snapshot IS NULL)
    OR (decision_id IS NOT NULL AND decision_record_hash IS NOT NULL AND decision_snapshot IS NOT NULL
      AND decision_record_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(decision_snapshot)='object'
      AND (decision_snapshot->>'decisionId') IS NOT DISTINCT FROM decision_id
      AND (decision_snapshot->>'recordHash') IS NOT DISTINCT FROM decision_record_hash))
);
CREATE INDEX account_follows_user ON football.account_follows(user_id,created_at DESC,id);
CREATE TABLE football.account_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES football.account_users(id),
  target_user_id uuid REFERENCES football.account_users(id),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_audit_target ON football.account_audit_events(target_user_id,created_at DESC);
CREATE FUNCTION football.reject_account_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Account audit events are append-only' USING ERRCODE='23000'; END;
$$;
CREATE TRIGGER account_audit_immutable BEFORE UPDATE OR DELETE ON football.account_audit_events
  FOR EACH ROW EXECUTE FUNCTION football.reject_account_audit_mutation();
CREATE TABLE football.account_auth_rate (
  bucket_key text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL CHECK (attempts>0)
);
