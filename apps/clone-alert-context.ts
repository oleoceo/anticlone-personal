import type { PoolClient } from 'pg';
import type { CloneAlert } from './clone-alert-email.js';

type IncidentKey = Pick<CloneAlert, 'outboxId' | 'incidentId' | 'project' | 'host'>;

export async function cloneAlertContext(db: PoolClient, key: IncidentKey): Promise<CloneAlert> {
  const {rows: [schema]} = await db.query(`SELECT to_regclass('investigation_receipts') IS NOT NULL
    AND to_regclass('protected_pages') IS NOT NULL AS page_receipts`);
  // Older installations can still deliver project/host alerts without LP evidence.
  const page = schema.page_receipts ? `(SELECT CASE WHEN count(DISTINCT p.id)=1 THEN min(p.name) END
      FROM investigation_receipts r JOIN protected_pages p ON p.id=r.page_id AND p.project_id=r.project_id
      WHERE r.project_id=i.project_id AND r.claimed_host=i.host AND r.kind='runtime_receipt'
        AND r.last_received_at>=clock_timestamp()-interval '7 days')` : 'NULL';
  const {rows: [context]} = await db.query(`SELECT i.first_seen AS "firstSeen", i.status,
      p.name AS "projectName", ${page} AS "pageName", risk.level AS risk, risk.confidence,
      ARRAY(SELECT DISTINCT signal.source FROM (
        SELECT s.source FROM observation_source_days s WHERE s.project_id=i.project_id AND s.host=i.host
          AND s.day >= (i.first_seen AT TIME ZONE 'UTC')::date
        UNION ALL
        SELECT c.source FROM canary_observations c WHERE c.project_id=i.project_id AND c.host=i.host
          AND c.observed_at>=clock_timestamp()-interval '7 days'
      ) signal ORDER BY signal.source) AS sources
    FROM incidents i LEFT JOIN projects p ON p.id=i.project_id
    LEFT JOIN LATERAL (
      SELECT r.level,r.confidence FROM risk_assessment_days r WHERE r.project_id=i.project_id AND r.host=i.host
        AND r.observed_at>=clock_timestamp()-interval '7 days'
      ORDER BY r.observed_at DESC,r.level,r.confidence,r.evaluator_version,r.source,r.reason LIMIT 1
    ) risk ON true
    WHERE i.id=$1 AND i.project_id=$2 AND i.host=$3`, [key.incidentId, key.project, key.host]);
  return {...key, ...context};
}
