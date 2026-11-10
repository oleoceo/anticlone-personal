import { notificationAdmission } from './notification-lifecycle.js';
import { createConnection } from 'node:net';
import {reviewedRelease} from './notification-lifecycle.js';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
import { reconcileF26 } from './notification-intents.js';
import { providerAuthorized, sendProviderAlert, type SmtpProvider } from './smtp-provider.js';
const reconciliationAfter = new WeakMap<Pool, Map<string, number>>();
export function makeMailer(port: number) {
  return nodemailer.createTransport({ host: '127.0.0.1', port, ignoreTLS: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000 });
}
// A total deadline is shorter than the one-minute persisted admission lease.
export async function sendLocalMail(port: number, options: SendMailOptions) {
  const socket=createConnection({host:'127.0.0.1',port});
  const transport=nodemailer.createTransport({host:'127.0.0.1',port,ignoreTLS:true,connectionTimeout:3000,greetingTimeout:3000,socketTimeout:3000,
    getSocket(_options,callback) {callback(null,{connection:socket});}
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([transport.sendMail(options),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{socket.destroy();reject(Error('local SMTP deadline'));},10_000);
    })]);
  } finally {if(timer) clearTimeout(timer);socket.destroy();transport.close();}
}
export async function deliverOne(pool: Pool, project: string, port: number | SmtpProvider): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cutoff=await notificationAdmission(client,project);
    if (cutoff===false) { await client.query('ROLLBACK'); return; }
    const released=await reviewedRelease(client,'CLONE','$2');
    const result = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1), 1) AS locked", [project]);
    if (!result.rows[0].locked) return;
    const history = (await client.query("SELECT to_regclass('clone_delivery_attempts') IS NOT NULL AS available")).rows[0].available;
    if (typeof port !== 'number' && (!history || !await providerAuthorized(client,port))) { await client.query('ROLLBACK'); return; }
    let deadlines = reconciliationAfter.get(pool);
    if (!deadlines) { deadlines = new Map(); reconciliationAfter.set(pool, deadlines); }
    if (Date.now() >= (deadlines.get(project) ?? 0)) {
      deadlines.set(project, Date.now() + 60_000);
      await reconcileF26(client, project);
    }
    // Admission commits before SMTP; no database lock crosses transport I/O.
    await client.query(`UPDATE alert_outbox a SET expired_at=clock_timestamp()
      FROM incidents i WHERE i.id=a.incident_id AND i.project_id=$1
      AND a.sent_at IS NULL AND a.expired_at IS NULL AND (a.attempts=0 OR a.next_attempt<=clock_timestamp())
      AND i.first_seen <= clock_timestamp()-interval '24 hours' AND ($2::timestamptz IS NULL OR i.first_seen>$2 OR ${released})`, [project,cutoff]);
    if (!budgetMayBeAvailable(pool)) { await client.query('COMMIT'); return; }
    let item: {id: string; host: string; attempts:number} | undefined;
    try {
      if (await lockBudget(client, pool)) {
        const pending = await client.query(`SELECT a.id, i.host, a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
          WHERE i.project_id=$1 AND ($2::timestamptz IS NULL OR i.first_seen>$2 OR ${released}) AND a.sent_at IS NULL AND a.expired_at IS NULL AND i.first_seen > clock_timestamp()-interval '24 hours' AND a.attempts < 3 AND a.next_attempt <= now() ORDER BY a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`, [project,cutoff]);
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
        const result=await sendLocalMail(port,{ from: 'anticlone@example.test', to: 'owner@example.test', subject: 'Unverified clone signal', text: `Unverified browser claim for host: ${item.host}`, messageId: `<anticlone-${item.id}@example.test>` });
          if (result.accepted.length!==1 || result.accepted[0]!=='owner@example.test') throw Error('recipient rejected');
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
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}
