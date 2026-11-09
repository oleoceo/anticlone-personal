-- Bind published versions without modifying immutable policy history. No
-- automatic association is made for legacy policies: it requires review.
ALTER TABLE protected_pages ADD COLUMN IF NOT EXISTS url_generation bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS page_cta_policy_bindings (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  surface text NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (project_id, page_id, surface),
  UNIQUE (project_id, surface),
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id),
  FOREIGN KEY (project_id, version, surface) REFERENCES cta_policy_versions(project_id, version, surface)
);

CREATE TABLE IF NOT EXISTS page_entry_policy_bindings (
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (project_id, page_id),
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id),
  FOREIGN KEY (project_id, version) REFERENCES protection_policy_versions(project_id, version)
);

CREATE TABLE IF NOT EXISTS page_policy_review_audit (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  page_id uuid NOT NULL,
  url_generation bigint NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb NOT NULL,
  FOREIGN KEY (page_id, project_id) REFERENCES protected_pages(id, project_id)
);

CREATE OR REPLACE FUNCTION invalidate_page_url_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.page_id<>NEW.page_id THEN
    UPDATE protected_pages SET url_generation=url_generation+1,url_review_required=true WHERE id=OLD.page_id;
  END IF;
  UPDATE protected_pages SET url_generation=url_generation+1,url_review_required=true
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.page_id ELSE NEW.page_id END;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS page_url_review_invalidation ON protected_page_urls;
CREATE TRIGGER page_url_review_invalidation AFTER INSERT OR DELETE OR UPDATE ON protected_page_urls
  FOR EACH ROW EXECUTE FUNCTION invalidate_page_url_review();
