CREATE TABLE IF NOT EXISTS cta_policy_versions (
 project_id text NOT NULL REFERENCES projects(id), version integer NOT NULL CHECK(version > 0),
 enabled boolean NOT NULL, surface text NOT NULL, pathname text NOT NULL, allocation jsonb NOT NULL,
 published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,version)
);
CREATE TABLE IF NOT EXISTS active_cta_policies (
 project_id text PRIMARY KEY REFERENCES projects(id), version integer NOT NULL,
 FOREIGN KEY(project_id,version) REFERENCES cta_policy_versions(project_id,version)
);
DROP TRIGGER IF EXISTS immutable_cta_policy ON cta_policy_versions;
CREATE TRIGGER immutable_cta_policy BEFORE UPDATE OR DELETE ON cta_policy_versions
 FOR EACH ROW EXECUTE FUNCTION prevent_published_policy_mutation();
