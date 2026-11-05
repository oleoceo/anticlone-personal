CREATE TABLE IF NOT EXISTS degradation_events (
 project_id text NOT NULL, host text NOT NULL, source text NOT NULL CHECK (source IN ('core','fallback')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 bucket timestamptz NOT NULL,
 PRIMARY KEY (project_id,host,source,bucket)
);
CREATE INDEX IF NOT EXISTS degradation_events_age ON degradation_events(project_id,observed_at);
CREATE TABLE IF NOT EXISTS degradation_audit (
 project_id text NOT NULL, host text NOT NULL, state text NOT NULL CHECK (state IN ('UNKNOWN','POSSIBLE_DEGRADATION')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), window_start timestamptz NOT NULL,
 uncertainty text NOT NULL DEFAULT 'UNAUTHENTICATED_CLAIMS',
 PRIMARY KEY(project_id,host,observed_at)
);
