CREATE TABLE controlled_installation_checks (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL,
 distribution_version integer NOT NULL,
 url_generation bigint NOT NULL,
 config_generation bigint NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result jsonb NOT NULL CHECK (jsonb_typeof(result)='object' AND result ? 'status' AND result->>'status' IN ('FULL','PARTIAL','UNSUPPORTED','NOT_VERIFIED')),
 FOREIGN KEY (page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE INDEX ON controlled_installation_checks(page_id,checked_at DESC);
COMMENT ON TABLE controlled_installation_checks IS 'Bounded current-load browser diagnostics only, not identity, universal compatibility or active mitigation certification. Seven day retention, ten rows per page.';
