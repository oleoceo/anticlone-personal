CREATE TABLE incident_status_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 incident_id bigint NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
 actor text NOT NULL CHECK (actor='local_administrator'),
 previous_status text NOT NULL CHECK (previous_status IN ('unverified','investigating','confirmed_copy','false_positive')),
 new_status text NOT NULL CHECK (new_status IN ('unverified','investigating','confirmed_copy','false_positive') AND new_status <> previous_status),
 alert_disposition text NOT NULL DEFAULT 'unchanged' CHECK (alert_disposition='unchanged'),
 justification text NOT NULL CHECK (length(justification) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX incident_status_audit_order ON incident_status_audit(incident_id,recorded_at,id);
ALTER TABLE investigation_timeline DROP CONSTRAINT investigation_timeline_event_type_check;
ALTER TABLE investigation_timeline ADD CONSTRAINT investigation_timeline_event_type_check CHECK (event_type IN ('first_observation','source_observed','risk_assessment','degradation_transition','dns_change','incident_status_transition'));
