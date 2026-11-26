CREATE TABLE observed_daily_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
INSERT INTO observed_daily_installation DEFAULT VALUES;

CREATE TABLE observed_daily_actions (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  day date NOT NULL,
  action text NOT NULL,
  traffic_class text NOT NULL,
  evidence text NOT NULL,
  copy_origin text,
  copy_path text,
  marker text,
  surface text,
  events bigint NOT NULL CHECK (events > 0),
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id),
  UNIQUE NULLS NOT DISTINCT (project_id, day, page_id, action, traffic_class, evidence, copy_origin, copy_path, marker, surface)
);

CREATE TABLE observed_daily_progress (
  project_id text PRIMARY KEY REFERENCES projects(id),
  complete_before date NOT NULL
);
