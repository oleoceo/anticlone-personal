import { notificationAdmission } from './notification-lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
import { reconcileF27 } from './notification-intents.js';

export type LocalSender = (alertId: string) => Promise<void>;

const reconciliationAfter=new WeakMap<Pool,Map<string,number>>();

export async function deliverCtaAlert(db: Pool, send: LocalSender): Promise<boolean> {
  const token = randomUUID();
  let id: string | undefined;
  const projects=await db.query('SELECT DISTINCT project_id FROM cta_drift_alerts ORDER BY project_id');
  for (const row of projects.rows) {
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const cutoff=await notificationAdmission(client,row.project_id);
      if (cutoff===false) { await client.query('ROLLBACK'); continue; }
      let deadlines=reconciliationAfter.get(db);
      if (!deadlines) {deadlines=new Map();reconciliationAfter.set(db,deadlines);}
      if (Date.now()>=(deadlines.get(row.project_id) ?? 0)) {
        deadlines.set(row.project_id,Date.now()+60_000);
        await reconcileF27(client,row.project_id);
      }
      await client.query(`UPDATE cta_alert_deliveries d SET state='EXPIRED',lease_token=NULL,lease_until=NULL
        FROM cta_drift_alerts a WHERE a.id=d.alert_id AND a.project_id=$1 AND d.delivery_mode='SMTP_LOCAL'
        AND ($2::timestamptz IS NULL OR a.created_at>$2) AND a.created_at<=clock_timestamp()-interval '24 hours'
        AND (d.state='PENDING' OR (d.state='PROCESSING' AND d.lease_until<=clock_timestamp()))`,[row.project_id,cutoff]);
      await client.query(`UPDATE cta_alert_deliveries d SET state='FAILED',lease_token=NULL,lease_until=NULL
        FROM cta_drift_alerts a WHERE a.id=d.alert_id AND a.project_id=$1 AND d.delivery_mode='SMTP_LOCAL'
        AND ($2::timestamptz IS NULL OR a.created_at>$2) AND d.state='PROCESSING' AND d.lease_until<=now() AND d.attempts=3`,[row.project_id,cutoff]);
      if (budgetMayBeAvailable(db) && await lockBudget(client,db)) {
        const result=await client.query(`WITH next AS (
          SELECT d.alert_id FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id
          WHERE a.project_id=$2 AND ($3::timestamptz IS NULL OR a.created_at>$3)
          AND a.created_at>clock_timestamp()-interval '24 hours' AND d.delivery_mode='SMTP_LOCAL' AND d.attempts<3
          AND ((d.state='PENDING' AND d.next_attempt<=now()) OR (d.state='PROCESSING' AND d.lease_until<=now()))
          ORDER BY d.alert_id FOR UPDATE OF d SKIP LOCKED LIMIT 1
        ) UPDATE cta_alert_deliveries d SET state='PROCESSING',attempts=d.attempts+1,lease_token=$1,
          lease_until=now()+interval '1 minute' FROM next WHERE d.alert_id=next.alert_id RETURNING d.alert_id`,[token,row.project_id,cutoff]);
        id=result.rows[0]?.alert_id;
        if (id) await recordBudget(client);
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
    if (id) break;
  }
  if (!id) return false;
  let success = false;
  try { await send(id); success = true; } catch { /* retry is persisted without provider details */ }
  await db.query(`UPDATE cta_alert_deliveries SET state=CASE WHEN $3 THEN 'DELIVERED'
    WHEN attempts=3 THEN 'FAILED' ELSE 'PENDING' END, result_kind=CASE WHEN $3 THEN 'SMTP_LOCAL_ACCEPTED' ELSE NULL END, next_attempt=now()+interval '1 minute', lease_token=NULL, lease_until=NULL
    WHERE alert_id=$1 AND lease_token=$2 AND state='PROCESSING'`, [id,token,success]);
  return true;
}
