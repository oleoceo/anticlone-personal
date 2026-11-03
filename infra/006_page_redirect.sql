CREATE TABLE IF NOT EXISTS page_redirect_policies (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL,
  approved_destination text NOT NULL,
  PRIMARY KEY (project_id, version)
);
