-- Additive, no inferred backfill: absent terms remain UNKNOWN.
ALTER TABLE cta_observations ADD COLUMN IF NOT EXISTS commercial_terms jsonb;
ALTER TABLE cta_commercial_references ADD COLUMN IF NOT EXISTS commercial_terms jsonb;
ALTER TABLE cta_commercial_audit ADD COLUMN IF NOT EXISTS commercial_terms jsonb;
ALTER TABLE cta_commercial_alert_evidence ADD COLUMN IF NOT EXISTS approved_terms jsonb;
ALTER TABLE cta_commercial_alert_evidence ADD COLUMN IF NOT EXISTS observed_terms jsonb;
