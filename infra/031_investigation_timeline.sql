CREATE TABLE investigation_timeline (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL, host text NOT NULL,
 event_type text NOT NULL CHECK (event_type IN ('first_observation','source_observed','risk_assessment','degradation_transition','dns_change')),
 source text NOT NULL, provenance text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 original_ref text, summary jsonb NOT NULL, confidence text NOT NULL, limitations text NOT NULL,
 CHECK (octet_length(summary::text) <= 1024), CHECK (length(limitations) <= 512)
);
CREATE INDEX investigation_timeline_project_order ON investigation_timeline(project_id,host,recorded_at DESC,id DESC);
CREATE INDEX investigation_timeline_retention ON investigation_timeline(project_id,recorded_at,id);
