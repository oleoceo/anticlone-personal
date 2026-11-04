-- Stop old processes before applying; start only updated processes afterward.
BEGIN;
ALTER TABLE cta_drift_alerts ADD COLUMN intent_reconcilable boolean NOT NULL DEFAULT false;
ALTER TABLE cta_drift_alerts ALTER COLUMN intent_reconcilable SET DEFAULT true;
DROP TRIGGER prepare_cta_alert_delivery ON cta_drift_alerts;
DROP FUNCTION prepare_cta_alert_delivery();
COMMIT;
