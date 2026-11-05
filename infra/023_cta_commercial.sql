-- Laboratory evidence and approval are distinct from URL review.
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS commercial_amount bigint CHECK (commercial_amount >= 0);
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS commercial_currency text CHECK (commercial_currency ~ '^[A-Z]{3}$');
ALTER TABLE cta_observations DROP CONSTRAINT IF EXISTS cta_commercial_complete;
ALTER TABLE cta_observations ADD CONSTRAINT cta_commercial_complete CHECK ((commercial_amount IS NULL) = (commercial_currency IS NULL));
CREATE TABLE IF NOT EXISTS cta_commercial_references (
 project_id text NOT NULL, point_id uuid NOT NULL, offer text NOT NULL, destination_id uuid NOT NULL,
 amount bigint NOT NULL CHECK (amount >= 0), currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 observation_id bigint NOT NULL, capture_id uuid NOT NULL, version integer NOT NULL DEFAULT 1, suspension text CHECK (suspension IN ('CHANGED','UNCERTAIN')),
 PRIMARY KEY(project_id,point_id),
 FOREIGN KEY(project_id,point_id,offer) REFERENCES cta_points(project_id,id,offer),
 FOREIGN KEY(project_id,offer,destination_id) REFERENCES cta_destinations(project_id,offer,id),
 FOREIGN KEY(capture_id) REFERENCES cta_captures(id)
);
CREATE TABLE IF NOT EXISTS cta_commercial_audit (
 id bigserial PRIMARY KEY, project_id text NOT NULL, point_id uuid NOT NULL, offer text NOT NULL,
 destination_id uuid NOT NULL, capture_id uuid NOT NULL, observation_id bigint NOT NULL,
 amount bigint NOT NULL, currency text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,point_id) REFERENCES cta_points(project_id,id)
);
ALTER TABLE cta_drift_alerts DROP CONSTRAINT cta_drift_alerts_reason_check;
ALTER TABLE cta_drift_alerts ADD CONSTRAINT cta_drift_alerts_reason_check CHECK (reason IN ('MARKER_COLLISION','DESTINATION_CHANGED','COMMERCIAL_CHANGED','COMMERCIAL_UNCERTAIN'));
