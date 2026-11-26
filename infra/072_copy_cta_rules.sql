CREATE TABLE copy_cta_inventory (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  copy_origin text NOT NULL,
  copy_pathname text NOT NULL,
  points jsonb NOT NULL CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 50),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id,page_id,copy_origin,copy_pathname),
  FOREIGN KEY (project_id,page_id,copy_origin,copy_pathname)
    REFERENCES page_copy_contexts(project_id,page_id,copy_origin,copy_pathname) ON DELETE CASCADE
);

CREATE TABLE copy_cta_rules (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  copy_origin text NOT NULL,
  copy_pathname text NOT NULL,
  surface text NOT NULL,
  marker text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  url_generation bigint NOT NULL,
  config_generation bigint NOT NULL,
  native_url text NOT NULL,
  native_digest text NOT NULL CHECK (native_digest ~ '^[a-f0-9]{64}$'),
  destination text NOT NULL,
  percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
  enabled boolean NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version),
  FOREIGN KEY (page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE INDEX copy_cta_rule_scope ON copy_cta_rules(project_id,page_id,copy_origin,copy_pathname,surface,marker,version DESC);

CREATE TRIGGER immutable_copy_cta_rules BEFORE UPDATE OR DELETE ON copy_cta_rules
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();
CREATE TRIGGER administrative_change AFTER INSERT ON copy_cta_rules
  FOR EACH ROW EXECUTE FUNCTION audit_administrative_change();
