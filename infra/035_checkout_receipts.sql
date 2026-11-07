-- No raw provider payload, customer identity or credentials are stored.
CREATE TABLE checkout_sales (
 project_id text NOT NULL REFERENCES projects(id),
 sale_id text NOT NULL CHECK (length(sale_id) BETWEEN 1 AND 128),
 amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 1000000000000),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attribution text NOT NULL DEFAULT 'UNVERIFIED' CHECK (attribution='UNVERIFIED'),
 PRIMARY KEY (project_id,sale_id)
);
CREATE TABLE checkout_receipts (
 project_id text NOT NULL,
 event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
 sale_id text NOT NULL,
 payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (project_id,event_id),
 FOREIGN KEY (project_id,sale_id) REFERENCES checkout_sales(project_id,sale_id)
);
