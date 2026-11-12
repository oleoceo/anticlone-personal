BEGIN;
-- Additive: current pointer may advance, but accepted formats and order scope survive.
ALTER TABLE commerce_connections ADD COLUMN legacy_model_version integer;
UPDATE commerce_connections SET legacy_model_version=model_version;
ALTER TABLE commerce_connections ALTER COLUMN legacy_model_version SET NOT NULL;
ALTER TABLE commerce_connections ADD UNIQUE(id,model_id);
CREATE TABLE commerce_connection_versions (
 connection_id uuid NOT NULL, model_id uuid NOT NULL, model_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','ACCEPTED')),
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 accepted_at timestamptz,
 PRIMARY KEY(connection_id,model_version),
 FOREIGN KEY(connection_id,model_id) REFERENCES commerce_connections(id,model_id),
 FOREIGN KEY(model_id,model_version) REFERENCES commerce_models(id,version)
);
CREATE UNIQUE INDEX commerce_one_pending_version ON commerce_connection_versions(connection_id) WHERE state='PENDING';
INSERT INTO commerce_connection_versions(connection_id,model_id,model_version,state,accepted_at)
 SELECT id,model_id,model_version,'ACCEPTED',created_at FROM commerce_connections;
-- Retain the legacy table/unique key for an executable rollback before format migration.
CREATE TABLE commerce_version_samples (
 connection_id uuid NOT NULL, model_version integer NOT NULL, shape jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(connection_id,model_version),
 FOREIGN KEY(connection_id,model_version) REFERENCES commerce_connection_versions(connection_id,model_version)
);
INSERT INTO commerce_version_samples SELECT s.connection_id,c.model_version,s.shape,s.received_at FROM commerce_samples s JOIN commerce_connections c ON c.id=s.connection_id;
ALTER TABLE commerce_events ADD COLUMN model_version integer;
ALTER TABLE commerce_events ADD COLUMN canonical_digest text;
UPDATE commerce_events e SET model_version=c.model_version FROM commerce_connections c WHERE c.id=e.connection_id;
ALTER TABLE commerce_events ALTER COLUMN model_version SET NOT NULL;
ALTER TABLE commerce_events ADD FOREIGN KEY(connection_id,model_version) REFERENCES commerce_connection_versions(connection_id,model_version);
ALTER TABLE commerce_orders ADD COLUMN model_version integer;
UPDATE commerce_orders o SET model_version=c.model_version FROM commerce_connections c WHERE c.id=o.connection_id;
ALTER TABLE commerce_orders ALTER COLUMN model_version SET NOT NULL;
ALTER TABLE commerce_orders ADD FOREIGN KEY(connection_id,model_version) REFERENCES commerce_connection_versions(connection_id,model_version);
CREATE FUNCTION commerce_connection_legacy_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.legacy_model_version:=coalesce(NEW.legacy_model_version,NEW.model_version); RETURN NEW; END $$;
CREATE TRIGGER commerce_legacy_default BEFORE INSERT ON commerce_connections FOR EACH ROW EXECUTE FUNCTION commerce_connection_legacy_default();
CREATE FUNCTION commerce_connection_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO commerce_connection_versions(connection_id,model_id,model_version,state,accepted_at)
 VALUES(NEW.id,NEW.model_id,NEW.model_version,'ACCEPTED',NEW.created_at); RETURN NEW; END $$;
CREATE TRIGGER commerce_bootstrap AFTER INSERT ON commerce_connections FOR EACH ROW EXECUTE FUNCTION commerce_connection_bootstrap();
CREATE FUNCTION commerce_legacy_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account commerce_connections%ROWTYPE;
BEGIN IF NEW.model_version IS NULL THEN
 SELECT * INTO account FROM commerce_connections WHERE id=NEW.connection_id;
 IF account.model_version<>account.legacy_model_version THEN RAISE EXCEPTION 'migrated account requires version-aware receiver'; END IF;
 NEW.model_version:=account.legacy_model_version;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER commerce_legacy_order BEFORE INSERT ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_legacy_record_version();
CREATE TRIGGER commerce_legacy_event BEFORE INSERT ON commerce_events FOR EACH ROW EXECUTE FUNCTION commerce_legacy_record_version();
CREATE FUNCTION commerce_legacy_sample_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS(SELECT 1 FROM commerce_connections WHERE id=NEW.connection_id AND model_version<>legacy_model_version) THEN RAISE EXCEPTION 'migrated account requires version-aware receiver'; END IF;
 INSERT INTO commerce_version_samples(connection_id,model_version,shape,received_at)
 SELECT NEW.connection_id,legacy_model_version,NEW.shape,NEW.received_at FROM commerce_connections WHERE id=NEW.connection_id
 ON CONFLICT(connection_id,model_version) DO UPDATE SET shape=excluded.shape,received_at=excluded.received_at; RETURN NEW; END $$;
CREATE TRIGGER commerce_legacy_sample AFTER INSERT OR UPDATE ON commerce_samples FOR EACH ROW EXECUTE FUNCTION commerce_legacy_sample_mirror();
CREATE FUNCTION commerce_legacy_sample_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM commerce_version_samples WHERE connection_id=OLD.connection_id
 AND model_version=(SELECT legacy_model_version FROM commerce_connections WHERE id=OLD.connection_id); RETURN OLD; END $$;
CREATE TRIGGER commerce_legacy_sample_deleted AFTER DELETE ON commerce_samples FOR EACH ROW EXECUTE FUNCTION commerce_legacy_sample_delete();
COMMIT;
