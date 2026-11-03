-- Existing versions remain NULL; republish to enable allocation.
ALTER TABLE protection_policy_drafts ADD COLUMN IF NOT EXISTS allocation jsonb;
ALTER TABLE protection_policy_versions ADD COLUMN IF NOT EXISTS allocation jsonb;
