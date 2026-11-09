-- Reversible lifecycle only. No DROP/DELETE or production execution is required.
ALTER TABLE projects ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
ALTER TABLE projects ADD CONSTRAINT project_deleted_is_archived CHECK (deleted_at IS NULL OR lifecycle_state='ARCHIVED');
CREATE TABLE project_lifecycle_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 previous_state text NOT NULL,
 current_state text NOT NULL,
 previous_deleted_at timestamptz,
 current_deleted_at timestamptz,
 previous_version bigint NOT NULL,
 current_version bigint NOT NULL,
 actor text NOT NULL CHECK(actor='OWNER_ADMIN'),
 justification text NOT NULL
);
CREATE FUNCTION audit_project_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
  NEW.lifecycle_version := OLD.lifecycle_version+1;
  INSERT INTO project_lifecycle_audit(project_id,previous_state,current_state,previous_deleted_at,current_deleted_at,previous_version,current_version,actor,justification)
   VALUES(OLD.id,OLD.lifecycle_state,NEW.lifecycle_state,OLD.deleted_at,NEW.deleted_at,OLD.lifecycle_version,NEW.lifecycle_version,'OWNER_ADMIN',coalesce(nullif(current_setting('anticlone.lifecycle_reason',true),''),'Existing administrative state control'));
 ELSE
  NEW.lifecycle_version := OLD.lifecycle_version;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_project_lifecycle BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION audit_project_lifecycle();
