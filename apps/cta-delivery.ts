import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';

export type LocalSender = (alertId: string) => Promise<void>;

export async function deliverCtaAlert(db: Pool, send: LocalSender): Promise<boolean> {
  if (!budgetMayBeAvailable(db)) return false;
  const token = randomUUID();
  const client = await db.connect();
  let id: string | undefined;
  try {
    await client.query('BEGIN');
    if (!await lockBudget(client, db)) { await client.query('COMMIT'); return false; }
    await client.query(`UPDATE cta_alert_deliveries SET state='FAILED', lease_token=NULL, lease_until=NULL
      WHERE delivery_mode='SMTP_LOCAL' AND state='PROCESSING' AND lease_until <= now() AND attempts=3`);
    const result = await client.query(`WITH next AS (
      SELECT alert_id FROM cta_alert_deliveries WHERE delivery_mode='SMTP_LOCAL' AND attempts < 3 AND
        ((state='PENDING' AND next_attempt <= now()) OR (state='PROCESSING' AND lease_until <= now()))
      ORDER BY alert_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE cta_alert_deliveries d SET state='PROCESSING', attempts=d.attempts+1,
      lease_token=$1, lease_until=now()+interval '1 minute' FROM next
      WHERE d.alert_id=next.alert_id RETURNING d.alert_id`, [token]);
    id = result.rows[0]?.alert_id;
    if (id) await recordBudget(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if (!id) return false;
  let success = false;
  try { await send(id); success = true; } catch { /* retry is persisted without provider details */ }
  await db.query(`UPDATE cta_alert_deliveries SET state=CASE WHEN $3 THEN 'DELIVERED'
    WHEN attempts=3 THEN 'FAILED' ELSE 'PENDING' END, result_kind=CASE WHEN $3 THEN 'SMTP_LOCAL_ACCEPTED' ELSE NULL END, next_attempt=now()+interval '1 minute', lease_token=NULL, lease_until=NULL
    WHERE alert_id=$1 AND lease_token=$2 AND state='PROCESSING'`, [id,token,success]);
  return true;
}
