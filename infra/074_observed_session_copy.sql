-- Session observations made by the updated scoped Bootstrap.
ALTER TABLE observed_action_facts ADD COLUMN session_copy jsonb
  CHECK (session_copy IS NULL OR action = 'SESSION_OBSERVED');
