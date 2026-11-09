import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {withProjectAdministrativeWrite} from './admin-project-write.js';
import {operationallyEligible} from './operational-eligibility.js';
import {recordObservedFact} from './observed-metrics.js';

type Decision={action:string;version?:number;mappings?:{marker:string;surface?:string}[]};
export async function issueObservedReceipt<T extends Decision>(db:Pool,project:string,page:string,origin:string,session:unknown,traffic:string,decision:T):Promise<T&{observationReceipt?:string}>{
 if(!['PAGE_REDIRECT','REPLACE_CONVERSION'].includes(decision.action)||typeof session!=='string'||!/^[a-f0-9]{32}$/.test(session)||!Number.isSafeInteger(decision.version))return decision;
 try{
  if(!(await db.query("SELECT to_regclass('observed_decision_receipts') IS NOT NULL installed")).rows[0].installed)return decision;
  const id=await withProjectAdministrativeWrite(db,project,async client=>{
   if(!await operationallyEligible(client,project,page,true))return null;
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1),47)',[project]);
   await client.query("DELETE FROM observed_decision_receipts WHERE project_id=$1 AND prepared_at<clock_timestamp()-interval '7 days'",[project]);
   const count=(await client.query('SELECT count(*)::int n FROM observed_decision_receipts WHERE project_id=$1',[project])).rows[0].n;if(count>=10000)return null;
   const receipt=randomUUID();
   const points=(decision.mappings??[]).map(row=>({marker:row.marker,surface:row.surface??null}));
   await client.query('INSERT INTO observed_decision_receipts(id,project_id,page_id,session_id,origin,action,policy_version,traffic_class,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[receipt,project,page,session,origin,decision.action,decision.version,traffic,JSON.stringify(points)]);
   return receipt;
  });
  return id?{...decision,observationReceipt:id}:decision;
 }catch{return decision;}
}
export async function observeReceiptAction(db:Pool,project:string,page:string,origin:string,body:Record<string,unknown>){
 if(Object.keys(body).sort().join(',')!=='event,marker,receipt,surface'||typeof body.event!=='string'||typeof body.receipt!=='string'||!['event','receipt'].every(key=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(body[key] as string)))throw new TypeError('invalid observation');
 const row=(await db.query('SELECT * FROM observed_decision_receipts WHERE id=$1 AND project_id=$2 AND page_id=$3 AND origin=$4 AND expires_at>clock_timestamp()',[body.receipt,project,page,origin])).rows[0];
 if(!row)throw new TypeError('unavailable receipt');
 const redirect=row.action==='PAGE_REDIRECT';
 if(redirect?(body.marker!==null||body.surface!==null):!row.points.some((point:{marker:string;surface:string|null})=>point.marker===body.marker&&point.surface===body.surface))throw new TypeError('ineligible point');
 return recordObservedFact(db,project,{page,event:redirect?row.id:body.event,session:row.session_id,action:redirect?'PAGE_REDIRECT_ATTEMPT':'CTA_CLICK_OBSERVED',traffic:row.traffic_class,version:row.policy_version,evidence:'BROWSER_UNVERIFIED'});
}
