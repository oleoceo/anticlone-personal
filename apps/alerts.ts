import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
export function makeMailer(port: number) {
  return nodemailer.createTransport({ host: '127.0.0.1', port, ignoreTLS: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
}
export async function deliverOne(pool: Pool, project: string, port: number): Promise<void> {
  if (!budgetMayBeAvailable(pool)) return;
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1), 1) AS locked", [project]);
    locked = result.rows[0].locked;
    if (!locked) return;
    await client.query('BEGIN');
    let item: {id: string; host: string} | undefined;
    try {
      if (await lockBudget(client, pool)) {
        const pending = await client.query(`SELECT a.id, i.host FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
          WHERE i.project_id=$1 AND a.sent_at IS NULL AND a.attempts < 3 AND a.next_attempt <= now() ORDER BY a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, [project]);
        item = pending.rows[0];
        if (item) {
          await client.query("UPDATE alert_outbox SET attempts=attempts+1, next_attempt=clock_timestamp()+interval '1 minute' WHERE id=$1", [item.id]);
          await recordBudget(client);
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
