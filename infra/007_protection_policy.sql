CREATE TABLE IF NOT EXISTS protection_policy_drafts (
 project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 enabled boolean NOT NULL, approved_destination text NOT NULL, stealth boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS protection_policy_versions (
 project_id text NOT NULL REFERENCES projects(id), version integer NOT NULL CHECK(version > 0),
 enabled boolean NOT NULL, approved_destination text NOT NULL, stealth boolean NOT NULL CHECK(stealth),
 published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,version)
);
CREATE TABLE IF NOT EXISTS active_protection_policies (
 project_id text PRIMARY KEY REFERENCES projects(id), version integer NOT NULL,
 FOREIGN KEY(project_id,version) REFERENCES protection_policy_versions(project_id,version)
);
CREATE OR REPLACE FUNCTION prevent_published_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published policies are immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_protection_policy ON protection_policy_versions;
CREATE TRIGGER immutable_protection_policy BEFORE UPDATE OR DELETE ON protection_policy_versions
 FOR EACH ROW EXECUTE FUNCTION prevent_published_policy_mutation();
