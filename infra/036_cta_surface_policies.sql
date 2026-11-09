-- Preserve the original active version while allowing independent surfaces.
CREATE UNIQUE INDEX IF NOT EXISTS cta_policy_version_surface_key
 ON cta_policy_versions(project_id,version,surface);
CREATE TABLE IF NOT EXISTS active_cta_surface_policies (
 project_id text NOT NULL REFERENCES projects(id), surface text NOT NULL,
 version integer NOT NULL, PRIMARY KEY(project_id,surface),
 FOREIGN KEY(project_id,version,surface)
   REFERENCES cta_policy_versions(project_id,version,surface)
);
INSERT INTO active_cta_surface_policies(project_id,surface,version)
 SELECT a.project_id,v.surface,a.version FROM active_cta_policies a
 JOIN cta_policy_versions v ON v.project_id=a.project_id AND v.version=a.version
 ON CONFLICT(project_id,surface) DO NOTHING;
