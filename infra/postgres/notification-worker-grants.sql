-- Apply as object owner with search_path pinned to the AntiClone schema.
-- The DBA creates anticlone_notification_worker as a NOLOGIN group role and
-- grants schema USAGE and membership to the dedicated unprivileged login.
GRANT SELECT ON projects, incidents, investigation_receipts, protected_pages,
  observation_source_days, canary_observations, risk_assessment_days,
  notification_settings, notification_settings_audit, notification_latest_review,
  notification_pause_history, health_settings_history, installation_health_settings,
  installation_last_signal, installations, cta_drift_alerts
TO anticlone_notification_worker;

GRANT SELECT ON alert_outbox, clone_delivery_attempts, cta_alert_deliveries,
  cta_delivery_attempts, health_delivery, health_delivery_attempts,
  health_episodes, health_operational_keys, notification_budget_lock, notification_attempt_budget
TO anticlone_notification_worker;

GRANT UPDATE (id) ON projects TO anticlone_notification_worker;
GRANT UPDATE (singleton) ON notification_settings, notification_budget_lock TO anticlone_notification_worker;
GRANT UPDATE (project_id) ON installations TO anticlone_notification_worker;

GRANT INSERT, DELETE ON notification_attempt_budget TO anticlone_notification_worker;
GRANT INSERT ON alert_outbox, clone_delivery_attempts, cta_alert_deliveries, cta_delivery_attempts,
  health_delivery, health_delivery_attempts, health_episodes, health_history, health_operational_keys
TO anticlone_notification_worker;
GRANT DELETE ON health_delivery_attempts TO anticlone_notification_worker;

GRANT UPDATE (attempts, next_attempt, sent_at, expired_at) ON alert_outbox, health_delivery TO anticlone_notification_worker;
GRANT UPDATE (finished_at, outcome) ON clone_delivery_attempts, cta_delivery_attempts, health_delivery_attempts TO anticlone_notification_worker;
GRANT UPDATE (state, attempts, next_attempt, lease_token, lease_until, delivery_mode, result_kind)
  ON cta_alert_deliveries TO anticlone_notification_worker;
GRANT UPDATE (recovered_at, invalidated_at) ON health_episodes TO anticlone_notification_worker;
