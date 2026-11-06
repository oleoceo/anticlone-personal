import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
import { reconcileF26 } from './notification-intents.js';
import { providerAuthorized, sendProviderAlert, type SmtpProvider } from './smtp-provider.js';
const reconciliationAfter = new WeakMap<Pool, Map<string, number>>();
export function makeMailer(port: number) {
  return nodemailer.createTransport({ host: '127.0.0.1', port, ignoreTLS: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
}
export async function deliverOne(pool: Pool, project: string, port: number | SmtpProvider): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1), 1) AS locked", [project]);
    locked = result.rows[0].locked;
    if (!locked) return;
    const history = (await client.query("SELECT to_regclass('clone_delivery_attempts') IS NOT NULL AS available")).rows[0].available;
    if (typeof port !== 'number' && (!history || !await providerAuthorized(client,port))) return;
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
    let item: {id: string; host: string; attempts:number} | undefined;
    try {
      if (await lockBudget(client, pool)) {
        const pending = await client.query(`SELECT a.id, i.host, a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
          WHERE i.project_id=$1 AND a.sent_at IS NULL AND a.expired_at IS NULL AND i.first_seen > clock_timestamp()-interval '24 hours' AND a.attempts < 3 AND a.next_attempt <= now() ORDER BY a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, [project]);
        item = pending.rows[0];
        if (item) {
          const reserved = await client.query(`UPDATE alert_outbox a SET attempts=a.attempts+1, next_attempt=clock_timestamp()+interval '1 minute'
            FROM incidents i WHERE a.id=$1 AND i.id=a.incident_id AND a.expired_at IS NULL
            AND i.first_seen > clock_timestamp()-interval '24 hours' RETURNING a.id`, [item.id]);
          if (reserved.rowCount) {
            await recordBudget(client);
            if (history) await client.query('INSERT INTO clone_delivery_attempts(outbox_id,attempt,transport) VALUES($1,$2,$3)',[item.id,item.attempts+1,typeof port==='number'?'SMTP_LOCAL':'SMTP_PROVIDER']);
          }
          else item = undefined;
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    if (!item) return;
    try {
      if (typeof port==='number') {
        const transport=makeMailer(port);
        try {
          const result=await transport.sendMail({ from: 'anticlone@example.test', to: 'owner@example.test', subject: 'Unverified clone signal', text: `Unverified browser claim for host: ${item.host}`, messageId: `<anticlone-${item.id}@example.test>` });
          if (result.accepted.length!==1 || result.accepted[0]!=='owner@example.test') throw Error('recipient rejected');
        } finally {transport.close();}
      } else await sendProviderAlert(port,item.id,item.host);
    } catch {
      if (history) await client.query("UPDATE clone_delivery_attempts SET finished_at=clock_timestamp(),outcome='FAILED' WHERE outbox_id=$1 AND attempt=$2",[item.id,item.attempts+1]);
      return; // Acceptance may be uncertain; retry is bounded, never exactly-once.
    }
    await client.query('BEGIN');
    try {
      await client.query('UPDATE alert_outbox SET sent_at=now() WHERE id=$1', [item.id]);
      if (history) await client.query("UPDATE clone_delivery_attempts SET finished_at=clock_timestamp(),outcome='ACCEPTED' WHERE outbox_id=$1 AND attempt=$2",[item.id,item.attempts+1]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), 1)', [project]);
    client.release();
  }
}
