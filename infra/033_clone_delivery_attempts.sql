CREATE TABLE clone_delivery_attempts (
 outbox_id bigint NOT NULL REFERENCES alert_outbox(id) ON DELETE CASCADE,
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
 transport text NOT NULL CHECK (transport IN ('SMTP_LOCAL','SMTP_PROVIDER')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN','ACCEPTED','FAILED')),
 PRIMARY KEY (outbox_id,attempt)
);
COMMENT ON TABLE clone_delivery_attempts IS 'SMTP acceptance is not mailbox delivery. UNKNOWN includes interrupted or ambiguous attempts. No provider errors or credentials are retained.';
