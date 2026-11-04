import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

// Local simulator: no network, recipient, or alert payload is involved.
export type Simulator = (alertId: string) => Promise<void>;
export const localSimulator: Simulator = async () => {};

export async function deliverCtaAlert(db: Pool, simulate: Simulator = localSimulator): Promise<boolean> {
  const token = randomUUID();
  const client = await db.connect();
  let id: string | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE cta_alert_deliveries SET state='FAILED', lease_token=NULL, lease_until=NULL
      WHERE state='PROCESSING' AND lease_until <= now() AND attempts=3`);
    const result = await client.query(`WITH next AS (
      SELECT alert_id FROM cta_alert_deliveries WHERE attempts < 3 AND
        ((state='PENDING' AND next_attempt <= now()) OR (state='PROCESSING' AND lease_until <= now()))
      ORDER BY alert_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE cta_alert_deliveries d SET state='PROCESSING', attempts=d.attempts+1,
      lease_token=$1, lease_until=now()+interval '1 minute' FROM next
      WHERE d.alert_id=next.alert_id RETURNING d.alert_id`, [token]);
    id = result.rows[0]?.alert_id;
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  if (!id) return false;
  let success = false;
  try { await simulate(id); success = true; } catch { /* retry is persisted without provider details */ }
  await db.query(`UPDATE cta_alert_deliveries SET state=CASE WHEN $3 THEN 'DELIVERED'
    WHEN attempts=3 THEN 'FAILED' ELSE 'PENDING' END, next_attempt=now()+interval '1 minute', lease_token=NULL, lease_until=NULL
    WHERE alert_id=$1 AND lease_token=$2 AND state='PROCESSING'`, [id,token,success]);
  return true;
}
