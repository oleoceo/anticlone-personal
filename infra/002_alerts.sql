CREATE TABLE IF NOT EXISTS observation_days (
 project_id text NOT NULL, host text NOT NULL, day date NOT NULL,
 PRIMARY KEY (project_id, host, day)
);
CREATE TABLE IF NOT EXISTS alert_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 incident_id bigint NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
 sent_at timestamptz, attempts integer NOT NULL DEFAULT 0,
 next_attempt timestamptz NOT NULL DEFAULT now()
);
