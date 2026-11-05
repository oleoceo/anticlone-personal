-- Capture identities are server-generated; historical observations remain ineligible.
CREATE TABLE IF NOT EXISTS cta_captures (
 id uuid PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, surface text NOT NULL,
 is_current boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (project_id,surface,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cta_current_capture ON cta_captures(project_id,surface) WHERE is_current;
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS capture_id uuid REFERENCES cta_captures(id);
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS selection_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS visual_context varchar(160);
CREATE TABLE IF NOT EXISTS cta_selection_intents (
 id bigserial PRIMARY KEY, project_id text NOT NULL, surface text NOT NULL, capture_id uuid NOT NULL,
 observation_id bigint NOT NULL, point_id uuid NOT NULL, observed_url text, offer text NOT NULL, destination_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'PENDING' CHECK (state='PENDING'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,surface,capture_id) REFERENCES cta_captures(project_id,surface,id),
 FOREIGN KEY(project_id,offer,destination_id) REFERENCES cta_destinations(project_id,offer,id)
);
