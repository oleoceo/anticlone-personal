ALTER TABLE copy_cta_rules ADD COLUMN allocation jsonb,
  ADD COLUMN activation_kind text NOT NULL DEFAULT 'a' CHECK (activation_kind IN ('a','button')),
  ADD COLUMN discovery_required boolean NOT NULL DEFAULT false,
  ADD COLUMN display_name text CHECK (length(display_name) BETWEEN 1 AND 80);

ALTER TABLE observed_action_facts ADD COLUMN copy_cta jsonb;
CREATE INDEX observed_copy_cta_scope ON observed_action_facts(project_id,page_id,received_at)
  WHERE copy_cta IS NOT NULL;
