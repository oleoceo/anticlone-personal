BEGIN;
CREATE TABLE notification_reviews (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 queue text NOT NULL CHECK (queue IN ('CLONE','CTA','HEALTH')),
 item_id text NOT NULL CHECK (item_id ~ '^[1-9][0-9]{0,18}$'),
 hold_cutoff timestamptz,
 pause_version bigint NOT NULL DEFAULT 0,
 decision text NOT NULL CHECK (decision IN ('RELEASE','CANCEL','ACK_UNKNOWN')),
 duplicate_risk_acknowledged boolean NOT NULL DEFAULT false,
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (decision<>'RELEASE' OR (hold_cutoff IS NOT NULL AND duplicate_risk_acknowledged))
);
CREATE INDEX ON notification_reviews(project_id,queue,item_id,id DESC);
CREATE VIEW notification_latest_review AS SELECT DISTINCT ON(project_id,queue,item_id) * FROM notification_reviews ORDER BY project_id,queue,item_id,id DESC;
CREATE OR REPLACE VIEW notification_lifecycle_queue AS
 SELECT i.project_id,'CLONE'::text AS queue,a.id::text AS item_id,i.first_seen AS created_at,a.attempts,h.hold_state FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id JOIN notification_project_holds h ON h.project_id=i.project_id
 WHERE a.sent_at IS NULL AND a.expired_at IS NULL AND (h.lifecycle_state<>'ACTIVE' OR i.first_seen<=h.cutoff)
 AND NOT EXISTS(SELECT 1 FROM notification_latest_review r WHERE h.lifecycle_state='ACTIVE' AND r.project_id=i.project_id AND r.queue='CLONE' AND r.item_id=a.id::text AND r.decision='RELEASE' AND r.hold_cutoff=h.cutoff AND r.pause_version=(SELECT max(id) FROM notification_pause_history WHERE project_id=i.project_id))
 UNION ALL
 SELECT e.project_id,'HEALTH',d.episode_id::text,e.opened_at,d.attempts,h.hold_state FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id JOIN notification_project_holds h ON h.project_id=e.project_id
 WHERE d.sent_at IS NULL AND d.expired_at IS NULL AND (h.lifecycle_state<>'ACTIVE' OR e.opened_at<=h.cutoff)
 AND NOT EXISTS(SELECT 1 FROM notification_latest_review r WHERE h.lifecycle_state='ACTIVE' AND r.project_id=e.project_id AND r.queue='HEALTH' AND r.item_id=d.episode_id::text AND r.decision='RELEASE' AND r.hold_cutoff=h.cutoff AND r.pause_version=(SELECT max(id) FROM notification_pause_history WHERE project_id=e.project_id))
 UNION ALL
 SELECT a.project_id,'CTA',d.alert_id::text,a.created_at,d.attempts,h.hold_state FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id JOIN notification_project_holds h ON h.project_id=a.project_id
 WHERE d.state IN ('PENDING','PROCESSING') AND (h.lifecycle_state<>'ACTIVE' OR a.created_at<=h.cutoff)
 AND NOT EXISTS(SELECT 1 FROM notification_latest_review r WHERE h.lifecycle_state='ACTIVE' AND r.project_id=a.project_id AND r.queue='CTA' AND r.item_id=d.alert_id::text AND r.decision='RELEASE' AND r.hold_cutoff=h.cutoff AND r.pause_version=(SELECT max(id) FROM notification_pause_history WHERE project_id=a.project_id));
CREATE VIEW notification_review_queue AS
 SELECT * FROM notification_lifecycle_queue
 UNION ALL SELECT a.project_id,'CTA',d.alert_id::text,a.created_at,d.attempts,'OUTCOME_UNKNOWN' FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id
 WHERE d.state='PROCESSING' AND d.lease_until<clock_timestamp() AND NOT EXISTS(SELECT 1 FROM notification_lifecycle_queue q WHERE q.queue='CTA' AND q.item_id=d.alert_id::text)
 UNION ALL SELECT e.project_id,'HEALTH',d.episode_id::text,e.opened_at,d.attempts,'OUTCOME_UNKNOWN' FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id
 WHERE d.sent_at IS NULL AND d.expired_at IS NULL AND d.attempts>0 AND d.next_attempt<=clock_timestamp()
 AND (EXISTS(SELECT 1 FROM health_delivery_attempts h WHERE h.episode_id=d.episode_id AND h.finished_at IS NULL) OR NOT EXISTS(SELECT 1 FROM health_delivery_attempts h WHERE h.episode_id=d.episode_id))
 AND NOT EXISTS(SELECT 1 FROM notification_lifecycle_queue q WHERE q.queue='HEALTH' AND q.item_id=d.episode_id::text);
COMMIT;
