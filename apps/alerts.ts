import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
import { reconcileF26 } from './notification-intents.js';
const reconciliationAfter = new WeakMap<Pool, Map<string, number>>();
export function makeMailer(port: number) {
  return nodemailer.createTransport({ host: '127.0.0.1', port, ignoreTLS: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
}
export async function deliverOne(pool: Pool, project: string, port: number): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1), 1) AS locked", [project]);
    locked = result.rows[0].locked;
    if (!locked) return;
    let deadlines = reconciliationAfter.get(pool);
    if (!deadlines) { deadlines = new Map(); reconciliationAfter.set(pool, deadlines); }
    if (Date.now() >= (deadlines.get(project) ?? 0)) {
      deadlines.set(project, Date.now() + 60_000);
      await reconcileF26(client, project);
    }
    // This lock remains held through SMTP, so active attempts cannot expire.
    await client.query(`UPDATE alert_outbox a SET expired_at=clock_timestamp()
      FROM incidents i WHERE i.id=a.incident_id AND i.project_id=$1
      AND a.sent_at IS NULL AND a.expired_at IS NULL
      AND i.first_seen <= clock_timestamp()-interval '24 hours'`, [project]);
    if (!budgetMayBeAvailable(pool)) return;
    await client.query('BEGIN');
    let item: {id: string; host: string} | undefined;
    try {
      if (await lockBudget(client, pool)) {
        const pending = await client.query(`SELECT a.id, i.host FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
          WHERE i.project_id=$1 AND a.sent_at IS NULL AND a.expired_at IS NULL AND i.first_seen > clock_timestamp()-interval '24 hours' AND a.attempts < 3 AND a.next_attempt <= now() ORDER BY a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, [project]);
        item = pending.rows[0];
        if (item) {
          const reserved = await client.query(`UPDATE alert_outbox a SET attempts=a.attempts+1, next_attempt=clock_timestamp()+interval '1 minute'
            FROM incidents i WHERE a.id=$1 AND i.id=a.incident_id AND a.expired_at IS NULL
            AND i.first_seen > clock_timestamp()-interval '24 hours' RETURNING a.id`, [item.id]);
          if (reserved.rowCount) await recordBudget(client);
          else item = undefined;
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    if (!item) return;
    try {
      await makeMailer(port).sendMail({ from: 'anticlone@example.test', to: 'owner@example.test', subject: 'Unverified clone signal', text: `Unverified browser claim for host: ${item.host}`, messageId: `<anticlone-${item.id}@example.test>` });
      await client.query('UPDATE alert_outbox SET sent_at=now() WHERE id=$1', [item.id]);
    } catch { /* The reservation remains consumed, even if acceptance is uncertain. */ }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), 1)', [project]);
    client.release();
  }
}
