-- The historical page anchor stays for immutable approvals. Only owned live
-- references are removed by the application; URL uniqueness remains unchanged.
ALTER TABLE protected_pages ADD COLUMN deleted_at timestamptz;
ALTER TABLE protected_pages ADD COLUMN deletion_version bigint NOT NULL DEFAULT 0;
ALTER TABLE protected_pages ADD CONSTRAINT deleted_page_inactive CHECK (deleted_at IS NULL OR (NOT enabled AND lifecycle_state='PAUSED'));
CREATE FUNCTION version_page_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'deletion_version') IS DISTINCT FROM (to_jsonb(OLD)-'deletion_version') THEN
  NEW.deletion_version:=OLD.deletion_version+1;
 ELSE NEW.deletion_version:=OLD.deletion_version; END IF;
 RETURN NEW;
END $$;
-- Run after the existing BEFORE invalidation triggers, so their changes count.
CREATE TRIGGER zz_version_page_deletion BEFORE UPDATE ON protected_pages FOR EACH ROW EXECUTE FUNCTION version_page_deletion();
CREATE TABLE page_deletion_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL,
 page_id uuid NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 justification text NOT NULL,
 snapshot jsonb NOT NULL,
 removed jsonb NOT NULL,
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE FUNCTION immutable_page_deletion_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'page deletion audit is immutable'; END $$;
CREATE TRIGGER immutable_page_deletion_audit BEFORE UPDATE OR DELETE ON page_deletion_audit FOR EACH ROW EXECUTE FUNCTION immutable_page_deletion_audit();
