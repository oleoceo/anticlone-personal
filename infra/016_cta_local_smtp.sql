BEGIN;
ALTER TABLE cta_alert_deliveries ADD COLUMN delivery_mode text NOT NULL DEFAULT 'SIMULATED' CHECK (delivery_mode IN ('SIMULATED','SMTP_LOCAL'));
ALTER TABLE cta_alert_deliveries ADD COLUMN result_kind text CHECK (result_kind IN ('SIMULATED','SMTP_LOCAL_ACCEPTED'));
UPDATE cta_alert_deliveries SET result_kind='SIMULATED' WHERE state='DELIVERED';
ALTER TABLE cta_alert_deliveries ALTER COLUMN delivery_mode SET DEFAULT 'SMTP_LOCAL';
COMMIT;
