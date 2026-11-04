CREATE TABLE IF NOT EXISTS cta_drift_alerts (
 id bigserial PRIMARY KEY, project_id text NOT NULL, point_id uuid NOT NULL,
 reason text NOT NULL CHECK (reason IN ('MARKER_COLLISION','DESTINATION_CHANGED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,point_id) REFERENCES cta_points(project_id,id)
);
