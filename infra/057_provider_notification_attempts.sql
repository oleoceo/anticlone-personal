BEGIN;
ALTER TABLE cta_alert_deliveries DROP CONSTRAINT cta_alert_deliveries_delivery_mode_check;
ALTER TABLE cta_alert_deliveries ADD CONSTRAINT cta_alert_deliveries_delivery_mode_check CHECK (delivery_mode IN ('SIMULATED','SMTP_LOCAL','SMTP_PROVIDER'));
ALTER TABLE cta_alert_deliveries DROP CONSTRAINT cta_alert_deliveries_result_kind_check;
ALTER TABLE cta_alert_deliveries ADD CONSTRAINT cta_alert_deliveries_result_kind_check CHECK (result_kind IN ('SIMULATED','SMTP_LOCAL_ACCEPTED','SMTP_PROVIDER_ACCEPTED'));
CREATE FUNCTION notification_default_cta_transport() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM notification_settings WHERE singleton=true AND requested) THEN 'SMTP_PROVIDER' ELSE 'SMTP_LOCAL' END
$$;
ALTER TABLE cta_alert_deliveries ALTER COLUMN delivery_mode SET DEFAULT notification_default_cta_transport();
CREATE TABLE cta_delivery_attempts (
 alert_id bigint NOT NULL REFERENCES cta_drift_alerts(id) ON DELETE CASCADE,
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
 transport text NOT NULL CHECK (transport IN ('SMTP_LOCAL','SMTP_PROVIDER')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN','ACCEPTED','FAILED')),
 PRIMARY KEY(alert_id,attempt)
);
CREATE TABLE health_delivery_attempts (
 episode_id bigint NOT NULL REFERENCES health_episodes(id) ON DELETE CASCADE,
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
 transport text NOT NULL CHECK (transport IN ('SMTP_LOCAL','SMTP_PROVIDER')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN','ACCEPTED','FAILED')),
 PRIMARY KEY(episode_id,attempt)
);
COMMENT ON TABLE cta_delivery_attempts IS 'Transport acceptance is not mailbox delivery; UNKNOWN is never proof of rejection. No credentials/provider errors retained.';
COMMENT ON TABLE health_delivery_attempts IS 'Transport acceptance is not mailbox delivery; unfinished attempts require review, never concurrent takeover.';
COMMIT;
