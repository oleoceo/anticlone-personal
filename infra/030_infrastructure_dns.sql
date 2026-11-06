CREATE TABLE infrastructure_dns_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  host text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN ('A','AAAA','CNAME','NS')),
  result jsonb NOT NULL,
  source text NOT NULL,
  state text NOT NULL CHECK (state IN ('OK','NO_DATA','NOT_AVAILABLE','INVALID','TIMEOUT','ERROR')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  limitations text NOT NULL
);
CREATE INDEX infrastructure_dns_history ON infrastructure_dns_observations(project_id,host,observed_at DESC,id DESC);
