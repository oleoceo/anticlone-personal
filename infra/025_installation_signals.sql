-- One explicitly enabled installation per project, restricted to its configured primary origin.
CREATE TABLE IF NOT EXISTS installations (
  project_id text PRIMARY KEY REFERENCES projects(id),
  id uuid NOT NULL UNIQUE,
  origin text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS installation_signals (
  project_id text NOT NULL REFERENCES installations(project_id),
  source text NOT NULL CHECK (source IN ('core', 'fallback')),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source)
);
