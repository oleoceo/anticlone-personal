-- Each confirmed publication is immutable. The latest revision is effective.
CREATE TABLE project_redirect_destinations (
  project_id text NOT NULL REFERENCES projects(id),
  revision integer NOT NULL CHECK (revision > 0),
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 2048),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE page_redirect_rules (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  copy_origin text NOT NULL,
  copy_pathname text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  url_generation bigint NOT NULL,
  config_generation bigint NOT NULL,
  policy_version integer NOT NULL,
  default_revision integer,
  enabled boolean NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, page_id, copy_origin, copy_pathname, revision),
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id),
  FOREIGN KEY (project_id, policy_version) REFERENCES protection_policy_versions(project_id, version),
  FOREIGN KEY (project_id, default_revision) REFERENCES project_redirect_destinations(project_id, revision)
);

CREATE TRIGGER immutable_project_redirect_destinations BEFORE UPDATE OR DELETE ON project_redirect_destinations
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();
CREATE TRIGGER immutable_page_redirect_rules BEFORE UPDATE OR DELETE ON page_redirect_rules
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();

CREATE TRIGGER administrative_change AFTER INSERT ON project_redirect_destinations
  FOR EACH ROW EXECUTE FUNCTION audit_administrative_change();
CREATE TRIGGER administrative_change AFTER INSERT ON page_redirect_rules
  FOR EACH ROW EXECUTE FUNCTION audit_administrative_change();
