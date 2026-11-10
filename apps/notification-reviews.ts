import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {assertProjectAdministrativeWrite} from './admin-project-write.js';
import {notificationAdmission,type NotificationQueue} from './notification-lifecycle.js';

export class NotificationReviewConflict extends Error{}
const queues=['CLONE','CTA','HEALTH'] as const;
const queries={
  CLONE:`SELECT a.id::text,i.first_seen AS created_at,a.attempts,a.next_attempt,a.sent_at,a.expired_at,'PENDING'::text AS state,NULL::timestamptz AS lease_until,false AS closed,NULL::text AS delivery_mode FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE a.id=$1 AND i.project_id=$2`,
  CTA:`SELECT d.alert_id::text AS id,a.created_at,d.attempts,d.next_attempt,NULL::timestamptz AS sent_at,NULL::timestamptz AS expired_at,d.state,d.lease_until,false AS closed,d.delivery_mode FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id WHERE d.alert_id=$1 AND a.project_id=$2`,
  HEALTH:`SELECT d.episode_id::text AS id,e.opened_at AS created_at,d.attempts,d.next_attempt,d.sent_at,d.expired_at,'PENDING'::text AS state,NULL::timestamptz AS lease_until,(e.recovered_at IS NOT NULL OR e.invalidated_at IS NOT NULL) AS closed,NULL::text AS delivery_mode FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id WHERE d.episode_id=$1 AND e.project_id=$2`
};
const attemptTables={CLONE:{table:'clone_delivery_attempts',key:'outbox_id'},CTA:{table:'cta_delivery_attempts',key:'alert_id'},HEALTH:{table:'health_delivery_attempts',key:'episode_id'}};
type Row={id:string;created_at:Date;attempts:number;next_attempt:Date;sent_at:Date|null;expired_at:Date|null;state:string;lease_until:Date|null;closed:boolean;delivery_mode:string|null};
async function item(db:Pool|PoolClient,queue:NotificationQueue,id:string,project:string,lock=false){
  const row=(await db.query<Row>(queries[queue]+(lock?' FOR UPDATE OF '+(queue==='CLONE'?'a':'d'):''),[id,project])).rows[0];
  if(!row)return;
  const pause=(await db.query(`SELECT coalesce(max(id),0)::text AS version,to_char(max(occurred_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff FROM notification_pause_history WHERE project_id=$1`,[project])).rows[0] as {version:string;cutoff:string|null};
  const review=(await db.query('SELECT id::text,decision FROM notification_latest_review WHERE project_id=$1 AND queue=$2 AND item_id=$3',[project,queue,id])).rows[0] as {id:string;decision:string}|undefined;
  const table=attemptTables[queue];
  const attempt=(await db.query(`SELECT transport,outcome,finished_at FROM ${table.table} WHERE ${table.key}=$1 AND attempt=$2`,[id,row.attempts])).rows[0] as {transport:string;outcome:string;finished_at:Date|null}|undefined;
  // A revision is a concurrency stamp, not a secret or identity fingerprint.
  const revision=createHash('sha256').update(JSON.stringify({row,pause,review,attempt})).digest('hex');
  return {row,pause,review,attempt,revision};
}

export async function notificationAdmin(db:Pool,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid review');
  const data=input as Record<string,unknown>;
  if(typeof data.project!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(data.project))throw new TypeError('invalid project');
  const project=data.project;
  if(!(await db.query("SELECT to_regclass('notification_latest_review') IS NOT NULL AS installed")).rows[0].installed)return {state:'SCHEMA_REQUIRED',items:[],history:[],attempts:[]};
  if(data.action==='inspect'){
    if(Object.keys(data).sort().join(',')!=='action,project')throw new TypeError('invalid inspect');
    if(!(await db.query('SELECT 1 FROM projects WHERE id=$1',[project])).rowCount)throw new TypeError('unknown project');
    const rows=await db.query('SELECT * FROM notification_review_queue WHERE project_id=$1 ORDER BY created_at,queue,item_id::bigint LIMIT 100',[project]);
    const items=[];
    for(const held of rows.rows){const current=await item(db,held.queue,held.item_id,project);if(current)items.push({...held,...current.row,revision:current.revision,last_review:current.review??null,last_attempt:current.attempt??null,mailbox_delivery:'UNVERIFIED'});}
    const history=await db.query('SELECT id::text,queue,item_id,decision,reason,occurred_at FROM notification_reviews WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[project]);
    const attempts=await db.query(`SELECT * FROM (
      SELECT 'CLONE' AS queue,h.outbox_id::text AS item_id,h.attempt,h.transport,h.started_at,h.finished_at,h.outcome FROM clone_delivery_attempts h JOIN alert_outbox a ON a.id=h.outbox_id JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1
      UNION ALL SELECT 'CTA',h.alert_id::text,h.attempt,h.transport,h.started_at,h.finished_at,h.outcome FROM cta_delivery_attempts h JOIN cta_drift_alerts a ON a.id=h.alert_id WHERE a.project_id=$1
      UNION ALL SELECT 'HEALTH',h.episode_id::text,h.attempt,h.transport,h.started_at,h.finished_at,h.outcome FROM health_delivery_attempts h JOIN health_episodes e ON e.id=h.episode_id WHERE e.project_id=$1
    ) h ORDER BY started_at DESC,queue,item_id LIMIT 100`,[project]);
    return {state:'AVAILABLE',items,history:history.rows,attempts:attempts.rows,mailbox_delivery:'UNVERIFIED',limitations:'SMTP acceptance is not mailbox delivery; prior committed admissions may finish. PROCESSING has no replay/cancel takeover.'};
  }
  if(Object.keys(data).sort().join(',')!=='acknowledgeDuplicateRisk,action,confirmation,item,project,queue,reason,revision'||!['RELEASE','CANCEL','ACK_UNKNOWN'].includes(String(data.action))||!queues.includes(data.queue as NotificationQueue)||typeof data.item!=='string'||!/^[1-9][0-9]{0,18}$/.test(data.item)||BigInt(data.item)>9223372036854775807n||typeof data.revision!=='string'||!/^[a-f0-9]{64}$/.test(data.revision)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>500||typeof data.acknowledgeDuplicateRisk!=='boolean'||data.confirmation!==data.queue+':'+data.item)throw new TypeError('invalid review fields');
  const queue=data.queue as NotificationQueue,id=data.item,client=await db.connect();
  try{
    await client.query('BEGIN');await assertProjectAdministrativeWrite(client,project,'SHARE');
    const current=await item(client,queue,id,project,true);
    if(!current||current.revision!==data.revision)throw new NotificationReviewConflict('item changed');
    const held=(await client.query('SELECT hold_state FROM notification_review_queue WHERE project_id=$1 AND queue=$2 AND item_id=$3',[project,queue,id])).rows[0];
    if(!held)throw new NotificationReviewConflict('item is no longer held');
    const r=current.row,now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    if(r.sent_at||r.expired_at||['DELIVERED','FAILED','EXPIRED'].includes(r.state))throw new NotificationReviewConflict('item completed');
    const unknown=r.attempts>0&&(!current.attempt||!current.attempt.finished_at||current.attempt.outcome==='UNKNOWN');
    if(r.state==='PROCESSING'&&(data.action!=='ACK_UNKNOWN'||!r.lease_until||r.lease_until>now))throw new NotificationReviewConflict('processing owner retained');
    if(r.state!=='PROCESSING'&&unknown&&r.next_attempt>now)throw new NotificationReviewConflict('transport admission may be active');
    if(data.action==='ACK_UNKNOWN'&&!unknown&&r.state!=='PROCESSING')throw new NotificationReviewConflict('no unknown outcome');
    if(data.action==='RELEASE'){
      if(data.acknowledgeDuplicateRisk!==true||r.state!=='PENDING'||r.closed||r.delivery_mode==='SIMULATED'||!current.pause.cutoff||r.created_at>new Date(current.pause.cutoff)||r.created_at.getTime()<=now.getTime()-86400000||r.attempts>=3||unknown||(r.attempts>0&&(current.attempt?.outcome!=='FAILED'||current.attempt.transport!=='SMTP_PROVIDER'))||await notificationAdmission(client,project)===false)throw new NotificationReviewConflict('release not safe');
    }
    if(data.action==='CANCEL'){
      if(queue==='CLONE')await client.query('UPDATE alert_outbox SET expired_at=clock_timestamp() WHERE id=$1',[id]);
      else if(queue==='HEALTH')await client.query('UPDATE health_delivery SET expired_at=clock_timestamp() WHERE episode_id=$1',[id]);
      else await client.query("UPDATE cta_alert_deliveries SET state='EXPIRED' WHERE alert_id=$1 AND state='PENDING'",[id]);
    }
    await client.query('INSERT INTO notification_reviews(project_id,queue,item_id,hold_cutoff,pause_version,decision,duplicate_risk_acknowledged,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[project,queue,id,current.pause.cutoff,current.pause.version,data.action,data.acknowledgeDuplicateRisk,data.reason.trim()]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return notificationAdmin(db,{action:'inspect',project});
}
