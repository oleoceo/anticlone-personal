-- Additive F45 policy audit. Null previous values denote the initial snapshot.
CREATE TABLE health_settings_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 previous_settings jsonb,
 current_settings jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX health_settings_history_project ON health_settings_history(project_id,id);
INSERT INTO health_settings_history(project_id,current_settings)
 SELECT project_id,jsonb_build_object('enabled',enabled,'operational_enabled',operational_enabled,'inactivity_seconds',inactivity_seconds)
 FROM installation_health_settings;
