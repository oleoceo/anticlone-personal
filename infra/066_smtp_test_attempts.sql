CREATE TABLE smtp_test_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 settings_version integer NOT NULL CHECK (settings_version >= 0),
 provider text NOT NULL CHECK (provider IN ('smtp','brevo')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN','ACCEPTED','FAILED')),
 failure_code text CHECK (failure_code IN ('AUTH_FAILED','SMTP_FAILED')),
 smtp_status integer CHECK (smtp_status BETWEEN 400 AND 599),
 recovered_record boolean NOT NULL DEFAULT false,
 CHECK ((outcome = 'UNKNOWN') = (finished_at IS NULL)),
 CHECK ((outcome = 'FAILED') = (failure_code IS NOT NULL))
);
CREATE INDEX smtp_test_attempts_started ON smtp_test_attempts(started_at DESC, id DESC);
