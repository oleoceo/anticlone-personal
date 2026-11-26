-- Apply with search_path pinned to the AntiClone schema after migrations.
-- Group roles are NOLOGIN; login creation, CONNECT and schema USAGE are a DBA step.
-- Both Gateways exercise the same runtime SQL. They use separate login credentials.
GRANT SELECT ON
  projects, protected_pages, protected_page_urls, installations, runtime_aliases, runtime_distributions,
  protection_policy_versions, active_protection_policies, page_redirect_rules, project_redirect_destinations,
  page_policy_approvals, page_policy_approval_entries, page_policy_approval_ctas, page_operational_authorizations,
  page_entry_policy_bindings, page_cta_policy_bindings, active_cta_surface_policies, active_cta_policies,
  cta_policy_versions, cta_points, cta_mappings, cta_destinations, cta_commercial_references, copy_cta_rules,
  copy_cta_inventory, page_copy_contexts, page_installation_signals, installation_signals, installation_last_signal,
  runtime_alias_activity, incidents, alert_outbox, observations, observation_source_days, observation_days,
  risk_assessment_days, traffic_observation_days, canary_observations, investigation_receipts, investigation_timeline,
  observed_action_facts, observed_decision_receipts, operator_shadow_assessments,
  degradation_events, degradation_audit, degradation_collection_gaps,
  checkout_receipts, checkout_sales, commerce_connections, commerce_connection_versions, commerce_bindings,
  commerce_models, commerce_orders, commerce_events, commerce_samples, commerce_version_samples
TO anticlone_gateway;
GRANT UPDATE (id) ON projects, protected_pages TO anticlone_gateway;
GRANT UPDATE (page_id) ON page_operational_authorizations TO anticlone_gateway;
GRANT UPDATE (project_id) ON installations TO anticlone_gateway;
GRANT INSERT ON incidents, alert_outbox, observations, observation_source_days, observation_days, canary_observations,
  traffic_observation_days, risk_assessment_days, investigation_timeline, investigation_receipts, runtime_alias_activity,
  page_copy_contexts, page_installation_signals, installation_signals, copy_cta_inventory, observed_action_facts,
  observed_decision_receipts, operator_shadow_assessments, degradation_events, degradation_audit, degradation_collection_gaps,
  checkout_receipts, checkout_sales, commerce_events, commerce_orders, commerce_samples, commerce_version_samples
TO anticlone_gateway;
GRANT UPDATE (last_seen) ON incidents TO anticlone_gateway;
GRANT UPDATE (last_received_at) ON investigation_receipts, runtime_alias_activity TO anticlone_gateway;
GRANT UPDATE (last_observed_at) ON page_installation_signals, installation_signals TO anticlone_gateway;
GRANT UPDATE (last_activity_at) ON installation_last_signal TO anticlone_gateway;
GRANT UPDATE (points, observed_at) ON copy_cta_inventory TO anticlone_gateway;
GRANT UPDATE (observed_at,gateway_at,gateway_visit,gateway_action,gateway_reason,gateway_version,browser_at,browser_visit,browser_phase,elapsed_ms)
  ON page_copy_contexts TO anticlone_gateway;
GRANT UPDATE (status,rank,paid_reported,paid_at,adjusted_at,reversed_at) ON commerce_orders TO anticlone_gateway;
GRANT UPDATE (shape,received_at) ON commerce_samples, commerce_version_samples TO anticlone_gateway;
GRANT UPDATE (last_dropped_at) ON degradation_collection_gaps TO anticlone_gateway;
GRANT DELETE ON copy_cta_inventory, page_copy_contexts, observed_decision_receipts,
  operator_shadow_assessments, degradation_events, degradation_audit, degradation_collection_gaps,
  commerce_samples, commerce_version_samples TO anticlone_gateway;

GRANT SELECT ON projects, protected_pages, protected_page_urls, runtime_aliases, installations,
  installation_health_settings, installation_last_signal, notification_pause_history, notification_latest_review,
  alert_outbox, incidents, observed_daily_actions, observed_daily_progress
TO anticlone_maintenance;
GRANT SELECT, DELETE ON administrative_change_audit, canary_observations, controlled_installation_checks,
  degradation_audit, degradation_collection_gaps, degradation_events, health_operational_keys, health_settings_history,
  infrastructure_dns_observations, installation_signals, investigation_receipts, investigation_timeline, notification_reviews,
  observation_days, observation_source_days, observations, observed_decision_receipts, operator_shadow_assessments,
  page_copy_contexts, page_installation_signals, risk_assessment_days, runtime_alias_activity, traffic_observation_days
TO anticlone_maintenance;
GRANT SELECT (project_id,received_at), DELETE ON observed_action_facts TO anticlone_maintenance;
GRANT INSERT, UPDATE, DELETE ON observed_daily_actions TO anticlone_maintenance;
GRANT INSERT, UPDATE ON observed_daily_progress TO anticlone_maintenance;
GRANT DELETE ON incidents, health_episodes TO anticlone_maintenance;
GRANT INSERT ON degradation_audit, degradation_collection_gaps TO anticlone_maintenance;
GRANT UPDATE (last_dropped_at) ON degradation_collection_gaps TO anticlone_maintenance;
GRANT INSERT ON infrastructure_dns_observations, investigation_timeline TO anticlone_maintenance;
GRANT UPDATE (first_observed_at) ON installation_last_signal TO anticlone_maintenance;

-- Admin diagnostics and purge preview read only these application relations.
GRANT SELECT ON
  active_cta_policies, active_cta_surface_policies, active_protection_policies, admin_totp_codes, admin_totp_replay,
  administrative_change_audit, alert_outbox, canary_observations, checkout_receipts, checkout_sales,
  clone_delivery_attempts, commerce_audit, commerce_bindings, commerce_connection_versions, commerce_connections,
  commerce_events, commerce_models, commerce_orders, commerce_samples, commerce_version_samples,
  controlled_installation_checks, copy_cta_inventory, copy_cta_rules, cta_alert_deliveries, cta_captures,
  cta_commercial_alert_evidence, cta_commercial_audit, cta_commercial_references, cta_delivery_attempts, cta_destinations,
  cta_drift_alerts, cta_mappings, cta_observations, cta_points, cta_policy_versions,
  cta_review_audit, cta_selection_intents, degradation_audit, degradation_collection_gaps, degradation_events,
  estimate_assumptions, health_delivery, health_delivery_attempts, health_episodes, health_history,
  health_operational_keys, health_settings_history, incident_status_audit, incidents, infrastructure_dns_observations,
  installation_health_settings, installation_last_signal, installation_signals, installations, investigation_receipts,
  investigation_timeline, notification_attempt_budget, notification_budget_lock, notification_pause_history, notification_reviews,
  notification_settings, notification_settings_audit, observation_days, observation_source_days, observations,
  observed_action_facts, observed_daily_actions, observed_daily_installation, observed_daily_progress, observed_decision_receipts,
  operator_shadow_assessments, page_copy_contexts, page_cta_policy_bindings, page_deletion_audit, page_entry_policy_bindings,
  page_installation_signals, page_operational_audit, page_operational_authorizations, page_policy_approval_ctas, page_policy_approval_entries,
  page_policy_approvals, page_policy_review_audit, page_redirect_policies, page_redirect_rules, project_lifecycle_audit,
  project_redirect_destinations, project_registration_audit, projects, protected_page_urls, protected_pages,
  protection_policy_drafts, protection_policy_versions, risk_assessment_days, runtime_alias_activity, runtime_aliases,
  runtime_distributions, smtp_test_attempts, telemetry_origins, traffic_observation_days
TO anticlone_admin;
GRANT SELECT ON notification_latest_review, notification_lifecycle_queue, notification_review_queue TO anticlone_admin;
GRANT INSERT ON admin_totp_codes, admin_totp_replay, administrative_change_audit,
  active_cta_policies, active_cta_surface_policies, active_protection_policies,
  commerce_audit, commerce_bindings, commerce_connection_versions, commerce_connections, commerce_models,
  controlled_installation_checks, copy_cta_rules, cta_captures, cta_commercial_alert_evidence,
  cta_commercial_audit, cta_commercial_references, cta_destinations, cta_drift_alerts, cta_mappings,
  cta_observations, cta_points, cta_policy_versions, cta_review_audit, cta_selection_intents,
  estimate_assumptions, health_settings_history, incident_status_audit, installation_health_settings,
  installation_signals, installations, investigation_receipts, investigation_timeline, notification_pause_history,
  notification_reviews, notification_settings_audit, page_cta_policy_bindings, page_deletion_audit,
  page_entry_policy_bindings, page_operational_audit, page_operational_authorizations,
  page_policy_approval_ctas, page_policy_approval_entries, page_policy_approvals, page_policy_review_audit,
  page_redirect_rules, project_lifecycle_audit, project_redirect_destinations, project_registration_audit,
  projects, protected_page_urls, protected_pages, protection_policy_drafts, protection_policy_versions,
  runtime_aliases, runtime_distributions, smtp_test_attempts, telemetry_origins
TO anticlone_admin;
GRANT UPDATE ON active_cta_policies, active_cta_surface_policies, active_protection_policies,
  admin_totp_replay, alert_outbox, commerce_bindings, commerce_connection_versions, commerce_connections,
  cta_alert_deliveries, cta_captures, cta_commercial_references, cta_destinations, cta_mappings, cta_observations,
  cta_points, cta_selection_intents, health_delivery, health_episodes, incidents, installation_health_settings,
  installations, notification_settings, page_cta_policy_bindings, page_entry_policy_bindings,
  page_operational_authorizations, projects, protected_pages, protection_policy_drafts, smtp_test_attempts, telemetry_origins
TO anticlone_admin;
-- SHARE ROW EXCLUSIVE table locks in page mutation require table-level UPDATE,
-- including on the bindings that are only modified via replacement.
GRANT UPDATE ON protected_page_urls TO anticlone_admin;
GRANT DELETE ON admin_totp_codes, commerce_connection_versions, commerce_samples, commerce_version_samples,
  controlled_installation_checks, cta_drift_alerts, cta_observations, cta_points, cta_mappings,
  page_cta_policy_bindings, page_entry_policy_bindings, page_installation_signals, protected_page_urls, smtp_test_attempts
TO anticlone_admin;

-- Bounded runtime cleanup is part of receipt persistence; the daily fact
-- archive remains owned by the maintenance profile.
GRANT DELETE ON investigation_receipts TO anticlone_gateway;
GRANT UPDATE (evidence_kind,evidence_provenance,evidence_reliability,observed_at)
  ON risk_assessment_days TO anticlone_gateway;
GRANT EXECUTE ON FUNCTION expire_observed_facts(text) TO anticlone_maintenance;
-- Timeline pruning and SERIAL defaults used by the administrative transactions.
GRANT DELETE ON investigation_timeline TO anticlone_gateway;
GRANT DELETE ON investigation_timeline, investigation_receipts TO anticlone_admin;
GRANT USAGE ON SEQUENCE cta_observations_id_seq, cta_review_audit_id_seq, cta_drift_alerts_id_seq,
  cta_selection_intents_id_seq, cta_commercial_audit_id_seq, page_policy_review_audit_id_seq,
  page_policy_approvals_id_seq, page_operational_audit_id_seq TO anticlone_admin;

-- Health reconciliation runs in the existing scheduled maintenance sweep.
-- SMTP delivery remains on the separate worker identity in the Dev profile.
GRANT SELECT ON health_episodes, health_delivery TO anticlone_maintenance;
GRANT INSERT ON health_episodes, health_delivery, health_history, health_operational_keys TO anticlone_maintenance;
GRANT UPDATE (recovered_at,invalidated_at) ON health_episodes TO anticlone_maintenance;
GRANT UPDATE (expired_at) ON health_delivery TO anticlone_maintenance;
GRANT UPDATE (id) ON projects TO anticlone_maintenance;
GRANT UPDATE (project_id) ON installations TO anticlone_maintenance;

-- Invoker triggers 028 and 044 maintain installation and pause history.
GRANT INSERT ON installation_last_signal TO anticlone_gateway, anticlone_admin;
GRANT UPDATE (first_observed_at,last_observed_at) ON installation_last_signal TO anticlone_gateway, anticlone_admin;
GRANT INSERT ON health_history TO anticlone_admin;
GRANT SELECT ON incident_status_audit TO anticlone_maintenance;
GRANT UPDATE (approved_terms,observed_terms) ON cta_commercial_alert_evidence TO anticlone_admin;
GRANT UPDATE (commercial_terms) ON cta_commercial_audit TO anticlone_admin;
GRANT INSERT ON cta_alert_deliveries TO anticlone_admin;
GRANT UPDATE (id) ON commerce_connections TO anticlone_gateway;
