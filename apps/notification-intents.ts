import type { Pool, PoolClient } from 'pg';

// Lock contention can be deferred after rolling back the intent savepoint.
// Resource exhaustion must propagate and abort the enclosing transaction.
const recoverable = new Set(['55P03']);
export async function tryIntent(client: PoolClient, insert: () => Promise<unknown>): Promise<void> {
  await client.query('SAVEPOINT notification_intent');
  try {
    await insert();
    await client.query('RELEASE SAVEPOINT notification_intent');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || !recoverable.has(String(error.code))) throw error;
    await client.query('ROLLBACK TO SAVEPOINT notification_intent');
    await client.query('RELEASE SAVEPOINT notification_intent');
    process.stderr.write('Notification intent deferred; reconciliation required\n');
  }
}

export async function reconcileF26(db: Pool | PoolClient, project: string): Promise<void> {
  await db.query(`INSERT INTO alert_outbox(incident_id, expired_at)
    SELECT i.id, CASE WHEN i.first_seen <= clock_timestamp()-interval '24 hours' THEN clock_timestamp() END
    FROM incidents i WHERE i.project_id=$1 AND NOT EXISTS
      (SELECT 1 FROM alert_outbox a WHERE a.incident_id=i.id)
    ORDER BY i.id LIMIT 100 ON CONFLICT (incident_id) DO NOTHING`, [project]);
}
export async function reconcileF27(db: Pool | PoolClient, project?: string): Promise<void> {
  const modern=(await db.query("SELECT to_regclass('cta_delivery_attempts') IS NOT NULL AS installed")).rows[0].installed;
  await db.query(`INSERT INTO cta_alert_deliveries(alert_id, delivery_mode, state)
    SELECT a.id, ${modern?"CASE WHEN EXISTS(SELECT 1 FROM notification_settings WHERE singleton=true AND requested) THEN 'SMTP_PROVIDER' ELSE 'SMTP_LOCAL' END":"'SMTP_LOCAL'"}, CASE WHEN a.created_at <= clock_timestamp()-interval '24 hours' THEN 'EXPIRED' ELSE 'PENDING' END
    FROM cta_drift_alerts a WHERE ($1::text IS NULL OR a.project_id=$1) AND a.intent_reconcilable AND NOT EXISTS
      (SELECT 1 FROM cta_alert_deliveries d WHERE d.alert_id=a.id)
    ORDER BY a.id LIMIT 100 ON CONFLICT (alert_id) DO NOTHING`,[project ?? null]);
}
