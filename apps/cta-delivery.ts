import { notificationAdmission } from './notification-lifecycle.js';
import { randomUUID } from 'node:crypto';
import {reviewedRelease} from './notification-lifecycle.js';
import type { Pool } from 'pg';
import { budgetMayBeAvailable, lockBudget, recordBudget } from './notification-budget.js';
import { reconcileF27 } from './notification-intents.js';
import {providerAuthorized,sendProviderNotice,type SmtpProvider} from './smtp-provider.js';

export type LocalSender = (alertId: string) => Promise<void>;

const maintenanceAfter=new WeakMap<Pool,Map<string,number>>();
const reconciliationAfter=new WeakMap<Pool,Map<string,number>>();

export async function deliverCtaAlert(db: Pool, send: LocalSender,options:{provider?:SmtpProvider;project?:string}={}): Promise<boolean> {
  const token = randomUUID();
  let id: string | undefined;
  let attempt=0,history=false;
  const mode=options.provider?'SMTP_PROVIDER':'SMTP_LOCAL';
  const projects=await db.query('SELECT DISTINCT project_id FROM cta_drift_alerts WHERE ($1::text IS NULL OR project_id=$1) ORDER BY project_id',[options.project??null]);
  for (const row of projects.rows) {
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const cutoff=await notificationAdmission(client,row.project_id);
      if (cutoff===false) { await client.query('ROLLBACK'); continue; }
      const releasedExpiry=await reviewedRelease(client,'CTA','$2'),releasedSelect=await reviewedRelease(client,'CTA','$3');
      history=(await client.query("SELECT to_regclass('cta_delivery_attempts') IS NOT NULL AS installed")).rows[0].installed;
      if(options.provider&&(!history||!await providerAuthorized(client,options.provider))){await client.query('ROLLBACK');continue;}
      let deadlines=reconciliationAfter.get(db);
      if (!deadlines) {deadlines=new Map();reconciliationAfter.set(db,deadlines);}
      if (Date.now()>=(deadlines.get(row.project_id) ?? 0)) {
        deadlines.set(row.project_id,Date.now()+60_000);
        await reconcileF27(client,row.project_id);
      }
      let sweeps=maintenanceAfter.get(db);
      if (!sweeps) {sweeps=new Map();maintenanceAfter.set(db,sweeps);}
      if (Date.now()>=(sweeps.get(row.project_id) ?? 0)) {
      await client.query(`UPDATE cta_alert_deliveries d SET state='EXPIRED',lease_token=NULL,lease_until=NULL
        FROM cta_drift_alerts a WHERE a.id=d.alert_id AND a.project_id=$1 AND d.delivery_mode IN ('SMTP_LOCAL','SMTP_PROVIDER')
        AND ($2::timestamptz IS NULL OR a.created_at>$2 OR ${releasedExpiry}) AND a.created_at<=clock_timestamp()-interval '24 hours'
        AND d.state='PENDING'`,[row.project_id,cutoff]);
      sweeps.set(row.project_id,Date.now()+60_000);
      }
      // Lease expiry cannot prove the transport stopped. PROCESSING keeps its
      // owner token until that callback settles; crash/unknown outcomes require
      // review, never an automatic takeover, expiry or concurrent retry.
      if (budgetMayBeAvailable(db) && await lockBudget(client,db)) {
        const result=await client.query(`WITH next AS (
          SELECT d.alert_id FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id
          WHERE a.project_id=$2 AND ($3::timestamptz IS NULL OR a.created_at>$3 OR ${releasedSelect})
          AND a.created_at>clock_timestamp()-interval '24 hours' AND (d.delivery_mode=$4 OR ($4='SMTP_PROVIDER' AND d.delivery_mode='SMTP_LOCAL' AND d.attempts=0)) AND d.attempts<3
          AND d.state='PENDING' AND d.next_attempt<=now()
          ORDER BY d.alert_id FOR UPDATE OF d SKIP LOCKED LIMIT 1
        ) UPDATE cta_alert_deliveries d SET state='PROCESSING',attempts=d.attempts+1,lease_token=$1,delivery_mode=$4,
          lease_until=now()+interval '1 minute' FROM next WHERE d.alert_id=next.alert_id RETURNING d.alert_id,d.attempts`,[token,row.project_id,cutoff,mode]);
        id=result.rows[0]?.alert_id;
        attempt=result.rows[0]?.attempts??0;
        if (id) {await recordBudget(client);if(history)await client.query('INSERT INTO cta_delivery_attempts(alert_id,attempt,transport) VALUES($1,$2,$3)',[id,attempt,mode]);}
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
    if (id) break;
  }
  if (!id) return false;
  let success = false;
  try { await send(id); success = true; } catch { /* retry is persisted without provider details */ }
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const finished=await client.query(`UPDATE cta_alert_deliveries SET state=CASE WHEN $3 THEN 'DELIVERED'
      WHEN attempts=3 THEN 'FAILED' ELSE 'PENDING' END, result_kind=CASE WHEN $3 THEN $4 ELSE NULL END, next_attempt=now()+interval '1 minute', lease_token=NULL, lease_until=NULL
      WHERE alert_id=$1 AND lease_token=$2 AND state='PROCESSING' RETURNING alert_id`, [id,token,success,mode+'_ACCEPTED']);
    if(history&&finished.rowCount)await client.query('UPDATE cta_delivery_attempts SET finished_at=clock_timestamp(),outcome=$3 WHERE alert_id=$1 AND attempt=$2',[id,attempt,success?'ACCEPTED':'FAILED']);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return true;
}

export async function deliverProviderCta(db:Pool,project:string,config:SmtpProvider){
  if(!(await db.query("SELECT to_regclass('cta_delivery_attempts') IS NOT NULL AS installed")).rows[0].installed)return false;
  return deliverCtaAlert(db,id=>sendProviderNotice(config,'cta-'+id,'AntiClone: CTA requires review',`Project ${project}: conversion-point change alert ${id}. Review the observed change; this does not establish operator identity.`),{project,provider:config});
}
