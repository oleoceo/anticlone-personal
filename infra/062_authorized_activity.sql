-- Optional investigative evidence. Never policy authority.
CREATE TABLE authorized_activity (
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL,
 source text NOT NULL,
 event_id uuid NOT NULL,
 actor_context text NOT NULL CHECK(length(actor_context)=64),
 session_context text,
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload jsonb NOT NULL,
 digest text NOT NULL,
 PRIMARY KEY(project_id,source,event_id),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE INDEX ON authorized_activity(project_id,page_id,session_context,observed_at DESC);
CREATE INDEX ON authorized_activity(project_id,page_id,actor_context,observed_at DESC);
COMMENT ON TABLE authorized_activity IS 'Authorized signed source assertions, not independent verification or human identity. Seven day retention, 10000 events/project; actor pseudonyms must rotate daily. No raw IP, URL, UA or credentials.';

-- Append a new snapshot when evidence changes in the same minute. Never rewrite history.
ALTER TABLE operator_shadow_assessments ADD COLUMN evidence_revision text NOT NULL DEFAULT 'baseline';
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='operator_shadow_assessments'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE operator_shadow_assessments DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $$;
ALTER TABLE operator_shadow_assessments ADD UNIQUE(project_id,page_id,host,session_context,bucket,evidence_revision);
