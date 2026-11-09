-- Approvals are append-only evidence for a specific page configuration.
-- No legacy policy is implicitly approved by this migration.
ALTER TABLE protected_pages ADD COLUMN config_generation bigint NOT NULL DEFAULT 0;
CREATE TABLE page_policy_approvals (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  url_generation bigint NOT NULL CHECK (url_generation >= 0),
  config_generation bigint NOT NULL CHECK (config_generation >= 0),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id),
  UNIQUE (id, project_id)
);

CREATE TABLE page_policy_approval_entries (
  approval_id bigint PRIMARY KEY,
  project_id text NOT NULL,
  version integer NOT NULL,
  FOREIGN KEY (approval_id, project_id) REFERENCES page_policy_approvals(id, project_id),
  FOREIGN KEY (project_id, version) REFERENCES protection_policy_versions(project_id, version)
);

CREATE TABLE page_policy_approval_ctas (
  approval_id bigint NOT NULL,
  project_id text NOT NULL,
  surface text NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (approval_id, surface),
  FOREIGN KEY (approval_id, project_id) REFERENCES page_policy_approvals(id, project_id),
  FOREIGN KEY (project_id, version, surface) REFERENCES cta_policy_versions(project_id, version, surface)
);

CREATE FUNCTION prevent_page_policy_approval_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'page policy approvals are immutable';
END $$;

CREATE TRIGGER immutable_page_policy_approvals BEFORE UPDATE OR DELETE ON page_policy_approvals
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();
CREATE TRIGGER immutable_page_policy_approval_entries BEFORE UPDATE OR DELETE ON page_policy_approval_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();
CREATE TRIGGER immutable_page_policy_approval_ctas BEFORE UPDATE OR DELETE ON page_policy_approval_ctas
  FOR EACH ROW EXECUTE FUNCTION prevent_page_policy_approval_mutation();

-- Increment even when a change is later reversed. Invalidate conservatively
-- across the project because surfaces and destinations can be shared.
CREATE FUNCTION invalidate_page_policy_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    UPDATE protected_pages SET config_generation=config_generation+1 WHERE project_id=OLD.project_id;
  END IF;
  UPDATE protected_pages SET config_generation=config_generation+1
    WHERE project_id=CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['active_protection_policies','active_cta_surface_policies','page_entry_policy_bindings','page_cta_policy_bindings','cta_points','cta_mappings','cta_destinations','cta_commercial_references'] LOOP
    EXECUTE format('CREATE TRIGGER page_policy_configuration_invalidation AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION invalidate_page_policy_configuration()',t);
  END LOOP;
END $$;
