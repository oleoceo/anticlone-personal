-- Additive opt-in; no published version or approval is rewritten.
ALTER TABLE protection_policy_versions DROP CONSTRAINT IF EXISTS protection_policy_versions_stealth_check;
ALTER TABLE protection_policy_versions ADD COLUMN IF NOT EXISTS stealth_version integer CHECK (stealth_version=2);
ALTER TABLE protection_policy_drafts ADD COLUMN IF NOT EXISTS stealth_version integer CHECK (stealth_version=2);
ALTER TABLE cta_policy_versions ADD COLUMN IF NOT EXISTS stealth boolean;
ALTER TABLE cta_policy_versions ADD COLUMN IF NOT EXISTS stealth_version integer CHECK (stealth_version=2);
ALTER TABLE protection_policy_versions ADD CONSTRAINT explicit_page_stealth CHECK (stealth OR (stealth_version=2 AND stealth_version IS NOT NULL));
ALTER TABLE cta_policy_versions ADD CONSTRAINT explicit_cta_stealth CHECK ((stealth_version IS NULL AND stealth IS NULL) OR (stealth_version IS NOT NULL AND stealth_version=2 AND stealth IS NOT NULL));
ALTER TABLE protection_policy_drafts ADD CONSTRAINT explicit_draft_stealth CHECK (stealth OR (stealth_version=2 AND stealth_version IS NOT NULL));
