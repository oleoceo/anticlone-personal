# Safe page closure and project deletion boundaries

Scope: F36/GS15, same single-owner admin interface and branch. Existing pause/archive/restore, DNS and CTA transport semantics were not rebuilt. No real project/page was deleted, no production migration was applied and no PR/deploy was created.

## Administrative writes on deleted projects

admin-project-write.ts checks deleted_at while holding a project row lock through the write transaction. It covers policy drafts/publication/activation, CTA policies/captures/inventory/selection/destinations/mappings/commercial approvals/review, installation enable/disable, health configuration and incident classification. Existing page/config mutation transactions continue checking the project and now also reject closed LP anchors. Queries and authorized project restoration remain available. A preflight outside the transaction cannot authorize a later write after the lifecycle transaction commits.

Mutators that already serialize via UPDATE keep that mode; health/standalone setters use SHARE where they do not later upgrade the project lock. Both modes conflict with lifecycle UPDATE and preserve the existing health-advisory lock order. Global notification provider settings have no project owner: they remain a global single-owner configuration, not a way to modify a deleted project's policy. Legitimate retention and previously admitted notification completion remain separate from administrative writes.

## Individual LP: definitive operational closure, historical anchor retained

Migration 046 adds deleted_at and a deletion_version to protected_pages, an inactive-tombstone constraint and mandatory append-only page_deletion_audit. The version changes on page configuration changes, including existing URL/binding invalidations. The existing authenticated/CSRF-protected pages endpoint provides preview-delete-page and delete-page; the panel has a separate LP form.

The preview reports exactly scoped removal counts, retained approval/audit counts, relevant FKs, the expected version and confirmation DELETE PAGE project/page-id/name. Deletion locks project then page, validates the exact confirmation/version, removes only page_cta_policy_bindings, page_entry_policy_bindings, page_installation_signals and protected_page_urls owned by the locked page, disables it and writes the deletion audit in one transaction. Audit failure rolls everything back. Concurrent or stale requests cannot apply twice.

The protected_pages row remains an inactive historical identity anchor. Immutable page_policy_approvals and their entries/CTA links, published policy versions and review audits stay unchanged; no trigger or FK is disabled. Project-level CTA inventory/captures/mappings, incidents, traffic, checkout sales and receipts are not demonstrably owned by one LP and are preserved. Unlisted dependencies are retained. This is not physical erasure of every row mentioning the LP.

Removed live URL rows release the existing UNIQUE(origin,pathname) constraint for a newly created page with new page/installation IDs. The closed identity cannot be resumed or receive a new URL. Old IDs remain reserved as historical identities; there cannot be two live pages claiming the same URL or installation ID. Other pages, including another LP in the same project, keep their configuration and evidence. Existing bounded browser policy-cache revocation still applies; this is not retroactive cancellation of already-loaded scripts. Scoped gateways continue using page identity; conservative legacy eligibility can still reject ambiguous projects containing multiple historical page anchors. Universal legacy continuity is not claimed.

## Physical project deletion: BLOCKED, not completed

preview-purge-project enumerates the resolved projects-table schema plus inbound FK-reachable dependencies from other user schemas. It reports project-key counts, FK-reachable candidates, shared/unproven counts, FK definitions and triggers. SQL identifiers come from the catalog and are quoted; values stay parameterized. Missing SELECT permission is an explicit blocker/count-null rather than silently treating dependencies as empty.

The purge-project request requires ARCHIVED, the expected lifecycle version and exact PURGE PROJECT ID:name confirmation plus justification, but always returns physicalDeletionAvailable=false and executed=false with the current blockers. No DELETE-project executor exists, even for apparently empty projects. The panel exposes inspection, not a fake purge success.

Concrete blockers in the tested complete schema include:

- immutable_protection_policy and immutable_cta_policy prohibit deleting published versions referenced by approval records.
- immutable_page_policy_approvals/entries/ctas prohibit changing or deleting approval evidence; the page/project FK graph still anchors that evidence.
- project_lifecycle_audit_project_id_fkey and notification_pause_history_project_id_fkey retain required audit ownership. No authorized detached historical project identity exists for deleting the parent row.
- checkout_sales_project_id_fkey retains financial ledger ownership; checkout_receipts and related evidence must not be silently discarded.
- Any cross-schema inbound FK is reported as an additional dependency with no approved external/shared purge ownership.

Erasing evidence or detaching these FKs without an explicit historical/financial retention and owner-identity policy would violate the preserved-history contract. This execution neither weakens immutability nor claims a verified physical purge. There is no global trigger disable, indiscriminate TRUNCATE or operational CASCADE fallback.

## Active database versus backups

Page closure removes only the identified live operational references from the active database. Its retained anchors/audits and existing backup snapshots remain. A future proven physical project purge would likewise not erase existing backups or external SMTP copies. Backup retention and preventing an old restore from reviving deleted identities are separate obligations; no backup purge or restore-replay automation was performed here. Existing REVIEW_REQUIRED notification backlog still has no release/approve/discard administrative action and is never replayed by deletion/restoration.

## Reproducible evidence

Build and run tests/safe-deletion.test.ts through dist with TEST_DATABASE_URL pointing to an isolated PostgreSQL laboratory. It creates its own schema plus a related external schema and destroys only those synthetic test schemas during cleanup. Chromium exercises the existing login/TOTP, CSRF, dependency preview and deletion form. Health and Finance share one domain with different page paths; Health has two LPs.

The test proves URL reuse with a new identity, uniqueness, stale and concurrent deletion, audit rollback, unchanged other LP/approval/financial/CTA rows, tombstone-versus-policy lock ordering, rejection of twelve administrative mutation families, Finance configuration/checkout continuity, consultable deleted projects, archived/versioned physical-purge refusal, external FK discovery and unchanged retained evidence. Tests do not use mocked eligibility. PostgreSQL barriers use concrete locks/PIDs rather than sleeps. Related policy/CTA/installation/health/triage/page/lifecycle regressions are run separately.

Final local checks: lint/typecheck/build PASS; the 19-case focused PostgreSQL/Chromium regression suite PASS. The integrated safe-deletion scenario also checks resolution of the actual projects schema when another schema is first in search_path. Independent read-only review: /root/safe_deletion_review. Remote CI was not started; this branch workflow runs on PR/main and no PR is authorized.
