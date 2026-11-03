-- Inventory is observational; approved configuration is separate and never expires with it.
CREATE TABLE IF NOT EXISTS cta_points (
 project_id text NOT NULL REFERENCES projects(id), id uuid NOT NULL, surface text NOT NULL, marker text,
 kind text NOT NULL CHECK (kind IN ('a','form','button')), offer text, review_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,id), UNIQUE(project_id,surface,marker), UNIQUE(project_id,id,offer)
);
CREATE TABLE IF NOT EXISTS cta_observations (
 id bigserial PRIMARY KEY, project_id text NOT NULL, point_id uuid NOT NULL,
 evidence text NOT NULL, confidence text NOT NULL, observed_url text,
 observed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,point_id) REFERENCES cta_points(project_id,id)
);
CREATE TABLE IF NOT EXISTS cta_destinations (
 project_id text NOT NULL REFERENCES projects(id), offer text NOT NULL, id uuid NOT NULL,
 url text NOT NULL, PRIMARY KEY(project_id,offer,id)
);
CREATE TABLE IF NOT EXISTS cta_mappings (
 project_id text NOT NULL, point_id uuid NOT NULL, offer text NOT NULL, destination_id uuid NOT NULL,
 PRIMARY KEY(project_id,point_id),
 FOREIGN KEY(project_id,point_id,offer) REFERENCES cta_points(project_id,id,offer),
 FOREIGN KEY(project_id,offer,destination_id) REFERENCES cta_destinations(project_id,offer,id)
);
