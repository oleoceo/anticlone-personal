CREATE TABLE IF NOT EXISTS observed_decision_receipts (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL,
 session_id text NOT NULL CHECK(session_id ~ '^[a-f0-9]{32}$'),
 origin text NOT NULL,
 action text NOT NULL CHECK(action IN ('PAGE_REDIRECT','REPLACE_CONVERSION')),
 policy_version integer NOT NULL CHECK(policy_version>0),
 traffic_class text NOT NULL CHECK(traffic_class IN ('PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN')),
 points jsonb NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '120 seconds',
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE INDEX IF NOT EXISTS observed_receipt_period ON observed_decision_receipts(project_id,prepared_at);
