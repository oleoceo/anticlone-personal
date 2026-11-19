import type {Pool} from 'pg';

export const smtpLogWindow = "interval '30 days'";

export async function listEmailAttempts(db: Pool) {
  const result = await db.query(`
    SELECT * FROM (
      SELECT 'TEST' AS kind, id::text AS item_id, 1 AS attempt, provider AS transport,
        NULL::text AS project, started_at, finished_at, outcome, failure_code, smtp_status, recovered_record
      FROM smtp_test_attempts WHERE started_at >= statement_timestamp() - ${smtpLogWindow}
      UNION ALL
      SELECT 'CLONE', a.outbox_id::text, a.attempt, a.transport, i.project_id,
        a.started_at, a.finished_at, a.outcome, NULL, NULL, false
      FROM clone_delivery_attempts a
      JOIN alert_outbox o ON o.id=a.outbox_id JOIN incidents i ON i.id=o.incident_id
      WHERE a.started_at >= statement_timestamp() - ${smtpLogWindow}
      UNION ALL
      SELECT 'CTA', a.alert_id::text, a.attempt, a.transport, d.project_id,
        a.started_at, a.finished_at, a.outcome, NULL, NULL, false
      FROM cta_delivery_attempts a JOIN cta_drift_alerts d ON d.id=a.alert_id
      WHERE a.started_at >= statement_timestamp() - ${smtpLogWindow}
      UNION ALL
      SELECT 'HEALTH', a.episode_id::text, a.attempt, a.transport, e.project_id,
        a.started_at, a.finished_at, a.outcome, NULL, NULL, false
      FROM health_delivery_attempts a JOIN health_episodes e ON e.id=a.episode_id
      WHERE a.started_at >= statement_timestamp() - ${smtpLogWindow}
    ) AS attempts ORDER BY started_at DESC, kind, item_id, attempt LIMIT 100
  `);
  return result.rows;
}

export async function retainSmtpTestAttempts(db: Pool) {
  const availability = await db.query("SELECT to_regclass('smtp_test_attempts') IS NOT NULL AS available");
  if (availability.rows[0].available) {
    await db.query(`DELETE FROM smtp_test_attempts WHERE started_at < statement_timestamp() - ${smtpLogWindow}`);
  }
}
