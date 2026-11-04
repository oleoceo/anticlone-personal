ALTER TABLE alert_outbox ADD COLUMN IF NOT EXISTS expired_at timestamptz;
