-- Additive: payloads and attempt history stay in their existing queues.
CREATE TABLE notification_pause_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_state text NOT NULL,
  current_state text NOT NULL
);
CREATE FUNCTION notification_pause_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    INSERT INTO notification_pause_history(project_id,previous_state,current_state)
      VALUES(NEW.id,OLD.lifecycle_state,NEW.lifecycle_state);
    IF to_regclass('installation_last_signal') IS NOT NULL THEN
      UPDATE installation_last_signal SET first_observed_at=NULL WHERE project_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_pause_record AFTER UPDATE OF lifecycle_state ON projects
  FOR EACH ROW EXECUTE FUNCTION notification_pause_record();
-- Existing paused projects also need a durable cutoff before their first resume.
INSERT INTO notification_pause_history(project_id,previous_state,current_state)
  SELECT id,'ACTIVE',lifecycle_state FROM projects WHERE lifecycle_state<>'ACTIVE';

CREATE VIEW notification_project_holds AS
SELECT p.id AS project_id,p.lifecycle_state,max(h.occurred_at) AS cutoff,
 CASE WHEN p.lifecycle_state<>'ACTIVE' THEN 'SUSPENDED' ELSE 'REVIEW_REQUIRED' END AS hold_state
FROM projects p LEFT JOIN notification_pause_history h ON h.project_id=p.id
GROUP BY p.id,p.lifecycle_state HAVING p.lifecycle_state<>'ACTIVE' OR max(h.occurred_at) IS NOT NULL;
DO $$
DECLARE parts text[] := ARRAY[]::text[];
BEGIN
 IF to_regclass('alert_outbox') IS NOT NULL THEN
  parts := array_append(parts, 'SELECT i.project_id,''CLONE''::text AS queue,a.id::text AS item_id,i.first_seen AS created_at,a.attempts,h.hold_state FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id JOIN notification_project_holds h ON h.project_id=i.project_id WHERE a.sent_at IS NULL AND a.expired_at IS NULL AND (h.lifecycle_state<>''ACTIVE'' OR i.first_seen<=h.cutoff)');
 END IF;
 IF to_regclass('health_delivery') IS NOT NULL THEN
  parts := array_append(parts, 'SELECT e.project_id,''HEALTH''::text AS queue,d.episode_id::text AS item_id,e.opened_at AS created_at,d.attempts,h.hold_state FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id JOIN notification_project_holds h ON h.project_id=e.project_id WHERE d.sent_at IS NULL AND d.expired_at IS NULL AND (h.lifecycle_state<>''ACTIVE'' OR e.opened_at<=h.cutoff)');
 END IF;
 IF to_regclass('cta_alert_deliveries') IS NOT NULL THEN
  parts := array_append(parts, 'SELECT a.project_id,''CTA''::text AS queue,d.alert_id::text AS item_id,a.created_at,d.attempts,h.hold_state FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id JOIN notification_project_holds h ON h.project_id=a.project_id WHERE d.state IN (''PENDING'',''PROCESSING'') AND (h.lifecycle_state<>''ACTIVE'' OR a.created_at<=h.cutoff)');
 END IF;
 IF cardinality(parts)>0 THEN
  EXECUTE 'CREATE VIEW notification_lifecycle_queue AS ' || array_to_string(parts,' UNION ALL ');
 END IF;
END $$;
