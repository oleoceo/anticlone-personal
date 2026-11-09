-- Existing project operation is preserved. A disabled page stays disabled.
ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
  CHECK (lifecycle_state IN ('ACTIVE', 'PAUSED', 'ARCHIVED'));
ALTER TABLE protected_pages ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
  CHECK (lifecycle_state IN ('ACTIVE', 'PAUSED'));
UPDATE protected_pages SET lifecycle_state='PAUSED' WHERE NOT enabled;
