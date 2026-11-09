# PR #60: six CI regressions

Base: 0c55a16bb2418886ddacaa44fcfb7c0e43588c0b. Failed CI: run 42681102965 (89 PASS, 6 FAIL). The same six failures were reproduced locally before changes, with real PostgreSQL and Chromium.

| Failure | Cause | Correction and preserved contract |
|---|---|---|
| multiproject-contract | Cleanup ran after clone delivery; a failed cleanup could consume a Finance attempt. | Cleanup precedes delivery within the observed maintenance failure boundary. Failure skips clone delivery, but health reconciliation continues. Finance remains at zero attempts when its cleanup fails; Health remains independent. |
| investigation-timeline | The eligibility catalog query cast projects to regclass in a genuine pre-projects schema. | Successful catalog inspection explicitly recognizes pre-projects schemas with incidents and without page/lifecycle tables. Missing modern catalogs and SQL errors still propagate; page-scoped requests cannot use this path. |
| timeline-failure | Same regclass cast aborted primary operations before their savepoint scenarios. | Same shared eligibility fix, including the notification admission catalog query. No fixture migration or global permissive error handler; transactional failures and primary records remain tested. |
| scoped-gateway | The page write guard raised unknown-page TypeError before approval's scoped generation validation. | Approval first applies its existing project/page/generation conflict validation, then checks the closed-page guard. Incompatible approvals return PageConflict; deleted projects and LPs remain blocked. |
| canary-degradation | Core HTTP response waited for correlation persistence, while the deterministic test held Core INSERT until HTTP 204. The cycle ended at statement timeout 57014. The observation error path also stopped marking known collection loss. | Queue Core correlation without delaying the passive response. Each queued action acquires its own lifecycle lock while executing, including all writes. Observation errors schedule gap reconciliation with eligibility. No timeout increase or barrier weakening. |
| health-gateway | Cleanup failure escaped after health reconciliation; project sweeps bypassed observation of the failure, and the legacy path reported recovery before failing cleanup again. | Cleanup and clone delivery share the failure boundary before health reconciliation in both paths. Retention still runs for inactive projects; episode creation/delivery retain transactional pause gates. |

## Validation

- Six original tests before changes: 0 PASS, 6 FAIL.
- Six original tests plus operational-eligibility regression: 7 PASS, 0 FAIL.
- Related pause/lifecycle/safe-deletion/health/gateway/notification/SMTP regression: 23 PASS, 0 FAIL.
- New real PostgreSQL gate regression covers pre-projects compatibility, scoped refusal, missing project, ACTIVE/PAUSED/ARCHIVED, damaged modern catalog and propagation of aborted transaction errors.
- Independent read-only review: /root/ci_six_review, approved without blocking findings. Tracked code diff 927ec4b2599a19ce1a9d225687d137afa9d55bf9; new test blob 9d8255c08f8e208d06f779b972f8e3ad698cd356.
- Related full-suite regressions: legacy HTTP gates could occupy all five pool connections before nested writes. HTTP admission now reserves at most two gates; queued F44 correlation uses its own lock and reserved headroom. Pre-027 correlation remains synchronous. GS02 now forces five concurrent requests behind a PostgreSQL advisory barrier and requires five HTTP 204 results.
- The degradation retention fixture formerly committed events before audit rows, allowing maintenance to run between the inserts. It now commits the complete fixture atomically and waits for both retention outcomes, keeping the final zero-count assertions and TTLs unchanged. No production retention refactor was retained.
- Independent review of the additional gateway/test delta: /root/ci_six_review approved; hash 363d21b3e402946137f4b1ca64628fc27af94b03. The initial reserve=false finding in schemas without migration 027 was fixed before commit.
- Initial Linux full run: 91 PASS, 5 FAIL. The five were retention-fixture synchronization, GS02 pool starvation, missing gateway.test resolution, missing historical Git objects in the copied lab, and PostgreSQL tool-version mismatch. The latter three were corrected in the isolated lab without repository changes. Focused reruns including HTTPS, historical rollback and real backup/restore passed.
- Full final Linux Node 22/PostgreSQL 16/Chromium/HTTPS suite: 96 PASS, 0 FAIL, 0 SKIP (219.4 seconds); lint/typecheck/build PASS. Documentary validation and 9 Python tests PASS. The Linux-tested source/test blobs match the working tree. Remote CI is checked on the single final commit in PR #60.

Physical project deletion remains BLOCKED without an executor. No immutable approval bypass, financial erasure, REVIEW_REQUIRED resolution, production migration, merge or deployment is included. PR #60 stays draft pending green CI on the final SHA.
