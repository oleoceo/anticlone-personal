-- No existing installation is authorized by this migration.
CREATE TABLE page_operational_authorizations (
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid PRIMARY KEY REFERENCES protected_pages(id),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL,
 approval_id bigint NOT NULL,
 url_generation bigint NOT NULL,
 config_generation bigint NOT NULL,
 copy_origin text NOT NULL,
 copy_pathname text NOT NULL
);
CREATE TABLE page_operational_audit (
 id bigserial PRIMARY KEY,
 project_id text NOT NULL,
 page_id uuid NOT NULL,
 revision integer NOT NULL,
 configuration jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(page_id,revision)
);
CREATE TRIGGER page_operational_audit_immutable BEFORE UPDATE OR DELETE ON page_operational_audit
 FOR EACH ROW EXECUTE FUNCTION runtime_distribution_immutable();
