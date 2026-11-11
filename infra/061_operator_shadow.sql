-- Complementary investigation only. No policy, approval or runtime contract changes.
CREATE TABLE operator_shadow_assessments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL,
 host text NOT NULL,
 session_context text NOT NULL CHECK(length(session_context)=64),
 bucket timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 assessment jsonb NOT NULL CHECK(jsonb_typeof(assessment)='object'),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id),
 UNIQUE(project_id,page_id,host,session_context,bucket)
);
CREATE INDEX ON operator_shadow_assessments(project_id,host,recorded_at DESC,id DESC);
COMMENT ON TABLE operator_shadow_assessments IS 'Untrusted scoped session correlation, daily rotation, seven-day retention and 10000 rows/project. Hash is not anonymization or identity. Shadow only, never policy authority.';
