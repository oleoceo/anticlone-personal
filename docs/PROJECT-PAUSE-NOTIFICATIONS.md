# Project pause: maintenance and notification admission

Scope: F01/F26/F36/F45, existing project administrative pause/resume. No new archive/delete operation, branch, PR or deploy.

## Operational boundary

Both projectMaintenance and legacy server maintenance consult the central eligibility gate. Paused/archived projects cannot collect installation/DNS observations, create health diagnoses, evaluate degradation transitions or reconcile operational failures. The actual write transactions also take a project SHARE lock before checking eligibility. The administrative control takes UPDATE on that same row. A stale sweep-level read cannot authorize a later write after a committed pause.

Retention of old observations, installation signals, degradation history and DNS history continues with project predicates. Incident/health payloads with unsent held notifications are exempt from cascading retention. Other projects continue independently. Transition resets the inactivity baseline; old traffic cannot produce a new inactivity diagnosis on resume.

## Queue policy actually implemented

Migration 044 is additive. Apply it after the existing lifecycle migration and installed notification capability migrations, with old workers stopped; only updated workers enforce admission. It records project transitions in notification_pause_history, including initially paused projects. No production migration was performed here.

Existing payloads, delivery flags and attempt history stay in their original queues. notification_project_holds records the project cutoff and notification_lifecycle_queue exposes held CLONE, HEALTH and CTA items:

- SUSPENDED while the project is not ACTIVE.
- REVIEW_REQUIRED on resume for sources created at or before the last transition cutoff. These records are not expired, discarded, marked SENT/DELIVERED or automatically replayed. They remain available for human investigation through these views and existing payload/history queries.
- Only sources newer than the resume cutoff are automatically eligible, subject to normal 24-hour freshness, retry and global budget limits. Cutoffs retain PostgreSQL timestamp precision.

There is no new endpoint to release, dismiss or replay the retained backlog. Reactivation alone never releases it. Explicit per-item review/replay would require a separate authorized implementation, including a freshness decision and audit; this change does not claim that capability. Existing explicit health-settings invalidation remains a separate operator action.

## Admission and transport

The three real dispatchers (deliverOne, deliverHealth, deliverCtaAlert) lock/check the project and persist the attempt plus budget within a transaction. Commit is the admission boundary; the project lock prevents a pause from committing ahead of that admission. Database failure, unknown project/state, or lifecycle installed without migration 044 prevents admission. Installations predating lifecycle keep their legacy behavior; existing page enablement is still checked.

SMTP begins after commit, with no PostgreSQL locks held. Attempts already admitted before pause may complete after pause; this is not retroactive cancellation. The existing persisted next_attempt (clone/health) or CTA lease protects admission for at least one minute, while SMTP has a total ten-second deadline and destroys its socket. Expiration respects that reservation. Process failure/uncertain SMTP acceptance can still cause a bounded retry after the reservation; exactly-once or mailbox delivery is not promised. SENT/DELIVERED is written only following SMTP acceptance.

## Reproducible proof

Build first, set TEST_DATABASE_URL to an isolated PostgreSQL laboratory, then run node --test dist/tests/project-pause-delivery.test.js. The test creates/removes its own schema and synthetic role. SMTP is loopback with controlled DATA callbacks. Coordination uses PostgreSQL row/advisory locks, NOTIFY and SMTP barriers; no arbitrary sleeps.

The integrated scenario demonstrates A/B active Health and Finance plus the existing managePages administrative pause; C/D suppressed operational transitions and new SMTP admissions; E Finance still sends; F payload/attempt preservation; G review hold across resume; H pause-first and admission-first concurrency, including health SMTP with no PG lock; I project-scoped retention, excluded-project sentinel and held backlog older than 30 days; J PostgreSQL permission failure and real refused connection block all three dispatchers. It also starts dist/apps/server.js with PROJECT_ID=health while paused and proves its retention via NOTIFY and Finance delivery via real SMTP.

The broader focused regression covers detection, lifecycle foundation, health settings/retries, notification expiry/budget/intents, degradation, DNS, optional-schema compatibility and SMTP provider TLS. Local SMTP acceptance is a laboratory result, not proof of external provider delivery.

## Independent review and final checks

Read-only session /root/pause_review approved the 21-file delta over 9686f6bbf77efe68d77e1251e79a71a2871b6020 with no remaining P0/P1/P2 findings. Its combined path/content SHA256 was 0bb02c951f20f8da0ab25c9a95da5d0b1e0ac8eaa28d16c0695f88119fcb3081 before adding this review record. Reviewer independently ran lint, typecheck and diff --check: PASS.

Implementer ran lint/typecheck/build and the 21-test focused suite: all PASS. After extending the integrated test with held payloads older than 30 days and real refused PostgreSQL connections, lint/typecheck/build and that final integrated test passed again. No code changed after the full focused suite; only the integrated test and documentation were extended. No remote CI/PR was started, as requested.
