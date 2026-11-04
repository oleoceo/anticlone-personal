CREATE TABLE IF NOT EXISTS notification_budget_lock (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton));
INSERT INTO notification_budget_lock(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS notification_attempt_budget (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS notification_attempt_budget_time ON notification_attempt_budget(reserved_at);
