# Archive, paused restore and reversible logical deletion

Scope: F36/GS15 on the existing single-owner administrative pages control. This change implements project lifecycle actions, not physical erasure or backup restore. No real project was archived/deleted/restored during execution; all exercised operations use isolated synthetic test data.

## Implemented contract

- archive-project changes ACTIVE or PAUSED to ARCHIVED. Existing public identifiers, pages, policies, clone evidence, checkout sales/receipts and notification records remain in place. The existing operational eligibility gate rejects ARCHIVED.
- restore-project accepts ARCHIVED, including a logically deleted project, clears its tombstone and returns PAUSED. It never restores directly to ACTIVE. An explicit later resume-project is necessary before new operations can be admitted; it does not release old notification backlog or approve page policies.
- delete-project is exclusively logical and reversible. It requires ARCHIVED, the exact expected lifecycle version, a justification and confirmation matching ID:name. It sets deleted_at using PostgreSQL time while keeping ARCHIVED. It never issues DELETE or removes dependencies. Repeated/stale commands conflict rather than duplicate an action.
- preview-delete-project returns project-scoped reference counts, version and required ID:name confirmation. It explicitly reports REVERSIBLE_LOGICAL and physicalDeletionAvailable=false. This inventory is not a physical purge plan. No physical deletion endpoint, destructive migration or purge worker is implemented.

The optional clarification about deletion semantics had no response while the corrections were completed. The conservative reversible mode was stated before implementation; physical erasure was not inferred from the request to continue safely. A future physical-deletion contract needs a separately explicit scope, dependency inventory, preservation/privacy policy and irreversible-action safeguards.

Archive/logical deletion preserve data within the existing documented retention windows; they do not freeze every raw observation indefinitely. Already held unsent notification payloads stay exempt from cascading retention. Existing aggregate/checkout records are not purged by these actions. The notification ledger/views keep pre-transition backlog SUSPENDED or REVIEW_REQUIRED after resume. There is still no administrative action to release, resolve, approve or discard these pendencies. Unknown CTA transport outcomes remain held PROCESSING as documented in PROJECT-PAUSE-NOTIFICATIONS.md.

## Administration, concurrency and audit

The existing authenticated and CSRF-protected /admin/ui/pages route serves the lifecycle form. No new authentication mechanism or public endpoint is added. Mutating lifecycle actions take FOR UPDATE on the project, check its version and admissible transition, then atomically write state, version and project_lifecycle_audit. Justification is required and bounded. Audit insertion failure rolls back the transition. Migration 045 also audits/version-bumps the previous pause/resume controls so concurrent state changes invalidate stale lifecycle forms. Historical actions are not fabricated/backfilled.

Page create/URL add/URL remove/policy approval lock and re-check the project tombstone within their own transactions before writing; a stale preflight cannot bypass a concurrent logical deletion. Project IDs never change; other projects remain independently operational. A prior admitted notification may still complete after archive/logical deletion, just as after pause; this is not retroactive transport cancellation.

Migration 045 is additive, follows 043/044 plus the installed capability migrations, and was applied only inside test schemas. No production migration or deployment was performed. The existing admin list continues to include logical-deletion records for consultation/restoration; the lifecycle form displays deletedAt and version.

## Evidence

Build first and run node --test dist/tests/project-lifecycle-admin.test.js with an isolated TEST_DATABASE_URL. The test uses real PostgreSQL, Chromium login/TOTP/CSRF, the actual existing admin route/forms and loopback SMTP. It covers archive, exact-name confirmation failures, logical tombstone, paused restore, preservation of identifiers/evidence/financial records, Finance continuing checkout, no notification backlog replay, stale/concurrent commands, audit failure rollback, and four deterministic tombstone races against page/config writes. No arbitrary sleeps coordinate these races.

Related regressions: pages-admin, project-pause-delivery, pause-review-races, lifecycle-foundation, checkout-webhook and protection-admin-ui. Physical erasure, a backup recovery operation, external SMTP delivery and per-item backlog resolution are not claimed by these tests.

Follow-up: SAFE-DELETION.md documents project administrative write guards, individual LP operational closure/URL release and the catalog-backed BLOCKED physical-project purge. These additions do not turn logical deletion into physical erasure.
