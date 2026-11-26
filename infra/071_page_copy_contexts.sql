-- Contexts observed for a published installation. Claims never authorize a rule.
CREATE TABLE page_copy_contexts (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  copy_origin text NOT NULL,
  copy_pathname text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  gateway_at timestamptz,
  gateway_visit text,
  gateway_action text,
  gateway_reason text,
  gateway_version integer,
  browser_at timestamptz,
  browser_visit text,
  browser_phase text,
  elapsed_ms integer CHECK (elapsed_ms BETWEEN 0 AND 60000),
  PRIMARY KEY (project_id,page_id,copy_origin,copy_pathname),
  FOREIGN KEY (page_id,project_id) REFERENCES protected_pages(id,project_id)
);
