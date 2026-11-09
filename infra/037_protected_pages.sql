-- The legacy installation remains intact for older code and rollback. The new
-- association uses its existing public identifier when one is already present.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_origin_key;

CREATE TABLE IF NOT EXISTS protected_pages (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  installation_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);

CREATE TABLE IF NOT EXISTS protected_page_urls (
  page_id uuid NOT NULL REFERENCES protected_pages(id),
  origin text NOT NULL,
  pathname text NOT NULL CHECK (pathname LIKE '/%' AND pathname NOT LIKE '%?%' AND pathname NOT LIKE '%#%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, origin, pathname),
  UNIQUE (origin, pathname)
);

-- A deterministic page ID makes the backfill safe to repeat. Project IDs are
-- already unique; the installation ID is never derived from an address.
INSERT INTO protected_pages(id,project_id,installation_id,name,enabled)
SELECT md5('legacy-page:' || p.id)::uuid, p.id, COALESCE(i.id, gen_random_uuid()), p.name, COALESCE(i.enabled, false)
FROM projects p LEFT JOIN installations i ON i.project_id=p.id
ON CONFLICT (id) DO NOTHING;

INSERT INTO protected_page_urls(page_id,origin,pathname)
SELECT md5('legacy-page:' || p.id)::uuid, p.origin, '/' FROM projects p
ON CONFLICT (page_id,origin,pathname) DO NOTHING;
