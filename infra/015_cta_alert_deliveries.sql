CREATE TABLE IF NOT EXISTS cta_alert_deliveries (
  alert_id bigint PRIMARY KEY REFERENCES cta_drift_alerts(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((state = 'PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state <> 'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE OR REPLACE FUNCTION prepare_cta_alert_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cta_alert_deliveries(alert_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prepare_cta_alert_delivery ON cta_drift_alerts;
CREATE TRIGGER prepare_cta_alert_delivery AFTER INSERT ON cta_drift_alerts
FOR EACH ROW EXECUTE FUNCTION prepare_cta_alert_delivery();
INSERT INTO cta_alert_deliveries(alert_id) SELECT id FROM cta_drift_alerts ON CONFLICT DO NOTHING;
