import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
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
    const pending = await client.query(`SELECT a.id, i.host FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
      WHERE i.project_id=$1 AND a.sent_at IS NULL AND a.next_attempt <= now() ORDER BY a.id LIMIT 1`, [project]);
    if (!pending.rowCount) return;
    const { id, host } = pending.rows[0] as {id: string, host: string};
    try {
      await makeMailer(port).sendMail({ from: 'anticlone@example.test', to: 'owner@example.test', subject: 'Unverified clone signal', text: `Unverified browser claim for host: ${host}`, messageId: `<anticlone-${id}@example.test>` });
      await client.query('UPDATE alert_outbox SET sent_at=now(), attempts=attempts+1 WHERE id=$1', [id]);
    } catch {
      await client.query("UPDATE alert_outbox SET attempts=attempts+1, next_attempt=now()+interval '1 minute' WHERE id=$1", [id]);
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), 1)', [project]);
    client.release();
  }
}
