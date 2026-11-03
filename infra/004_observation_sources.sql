CREATE TABLE IF NOT EXISTS observation_source_days (
 project_id text NOT NULL, host text NOT NULL, day date NOT NULL, source text NOT NULL CHECK (source IN ('core', 'fallback')),
 PRIMARY KEY (project_id, host, day, source)
);
