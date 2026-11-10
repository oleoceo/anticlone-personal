-- Optional, minimized evidence. No visitor identifiers, URLs or request bodies.
CREATE TABLE investigation_receipts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL REFERENCES protected_pages(id),
 installation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('original_request','runtime_receipt')),
 source text NOT NULL,
 resource text NOT NULL,
 alias uuid,
 claimed_host text,
 import_id uuid,
 first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 bucket timestamptz NOT NULL DEFAULT date_trunc('minute',clock_timestamp()),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id),
 CHECK ((kind='original_request' AND import_id IS NOT NULL AND claimed_host IS NULL AND alias IS NULL)
     OR (kind='runtime_receipt' AND import_id IS NULL)),
 UNIQUE(project_id,import_id)
);
CREATE UNIQUE INDEX investigation_receipts_runtime_dedup ON investigation_receipts
 (project_id,page_id,source,resource,COALESCE(alias,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE(claimed_host,''),bucket) WHERE kind='runtime_receipt';
CREATE INDEX investigation_receipts_retention ON investigation_receipts(project_id,last_received_at);
