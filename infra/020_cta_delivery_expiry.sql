ALTER TABLE cta_alert_deliveries DROP CONSTRAINT cta_alert_deliveries_state_check;
ALTER TABLE cta_alert_deliveries ADD CONSTRAINT cta_alert_deliveries_state_check CHECK (state IN ('PENDING','PROCESSING','DELIVERED','FAILED','EXPIRED'));
