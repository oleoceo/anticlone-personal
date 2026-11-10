import type {Pool,PoolClient} from 'pg';
import {assertPageAdministrativeWrite,withProjectAdministrativeWrite} from './admin-project-write.js';
import {resolvePageContext,type PageContext} from './page-context.js';
import {operationallyEligible} from './operational-eligibility.js';
import type {IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
export const receiptAliases=new WeakMap<IncomingMessage,string>();

const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const receiptColumns="id,page_id,installation_id,kind,source,resource,alias,claimed_host,first_received_at,last_received_at,(to_jsonb(r)->>'accessed_at')::timestamptz AS accessed_at";
export type ReceiptRow={id:string;page_id:string;installation_id:string;kind:string;source:string;resource:string;alias:string|null;claimed_host:string|null;first_received_at:Date;last_received_at:Date;accessed_at:Date|null};
export function presentReceipt(item:ReceiptRow,host?:string) {
  return {...item,imported_at:item.kind==='original_request'?item.first_received_at:null,
    accessed_at:item.accessed_at??'UNKNOWN',accessed_at_provenance:item.accessed_at?'AUTHORIZED_LOG_DECLARATION_NOT_INDEPENDENTLY_VERIFIED':'UNKNOWN',
    confidence:item.kind==='original_request'?'ADMINISTRATOR_ATTESTED_LOG':'SERVER_RECEIPT_ONLY',
    provenance:item.kind==='original_request'?'administrator_import':'gateway',
    relation:host&&item.claimed_host===host?'claimed_host_and_page':'page_context_only',operator_identity:'UNKNOWN'};
}
// Ascending ID keyset traverses all retained evidence, never a numeric OFFSET.
export async function receiptHistory(db:Pool,project:string,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid cursor');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['after','page'].includes(key)) || (value.page!==undefined&&(typeof value.page!=='string'||!uuid.test(value.page))) || (value.after!==undefined&&(typeof value.after!=='string'||! /^(0|[1-9][0-9]{0,18})$/.test(value.after)||BigInt(value.after)>9223372036854775807n)))throw new TypeError('invalid cursor');
  const installed=(await db.query("SELECT to_regclass('investigation_receipts') IS NOT NULL AS installed")).rows[0].installed;
  if(!installed)return {available:false,events:[],next_after:null};
  const rows=(await db.query(`SELECT ${receiptColumns} FROM investigation_receipts r WHERE project_id=$1 AND id>$2::bigint AND ($3::uuid IS NULL OR page_id=$3::uuid) AND last_received_at>=clock_timestamp()-interval '7 days' AND ((to_jsonb(r)->>'accessed_at') IS NULL OR (to_jsonb(r)->>'accessed_at')::timestamptz>=clock_timestamp()-interval '7 days') ORDER BY id LIMIT 101`,[project,value.after??'0',value.page??null])).rows;
  return {available:true,events:rows.slice(0,100).map(item=>presentReceipt(item)),next_after:rows.length>100?String(rows[99].id):null,limit:100,retention_days:7,
    limitation:'Retained context only, not visitor identity. ID order is import/receipt order, not declared access order. Retention and concurrent imports can change subsequent pages.'};
}
export async function retainInvestigationReceipts(db:Pool|PoolClient,project:string) {
  if (!(await db.query("SELECT to_regclass('investigation_receipts') IS NOT NULL AS installed")).rows[0].installed)return;
  const extended=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='investigation_receipts'::regclass AND attname='accessed_at' AND NOT attisdropped) AS installed")).rows[0].installed;
  await db.query(`DELETE FROM investigation_receipts WHERE project_id=$1 AND (last_received_at<statement_timestamp()-interval '7 days'${extended?" OR accessed_at<statement_timestamp()-interval '7 days'":''})`,[project]);
}
function accessTime(value:unknown):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new TypeError('invalid accessed_at');
  return value;
}
// Import is an authenticated administrator assertion about an authorized log.
// Import time is server time, deliberately never represented as original access time.
export async function importOriginalRequest(db:Pool,project:string,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid import');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).filter(key=>key!=='accessed_at').sort().join(',')!=='authorized,id,page,resource,source' || value.authorized!==true || typeof value.id!=='string'||!uuid.test(value.id)||typeof value.page!=='string'||!uuid.test(value.page)||!['HTML','SCRIPT','STYLE','IMAGE','OTHER'].includes(value.resource as string)||!['owned_access_log','authorized_provider_log'].includes(value.source as string))throw new TypeError('invalid import');
  const accessed=accessTime(value.accessed_at);
  return withProjectAdministrativeWrite(db,project,async client=>{
    await assertPageAdministrativeWrite(client,project,value.page as string);
    if(!await operationallyEligible(client,project,value.page as string,true))throw new TypeError('inactive context');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[project]);
    await retainInvestigationReceipts(client,project);
    const prior=(await client.query("SELECT page_id,resource,source,first_received_at,to_jsonb(r)->>'accessed_at' AS accessed_at FROM investigation_receipts r WHERE project_id=$1 AND import_id=$2",[project,value.id])).rows[0];
    if(prior){if(prior.page_id!==value.page||prior.resource!==value.resource||prior.source!==value.source||(prior.accessed_at?new Date(prior.accessed_at).toISOString():null)!==accessed)throw new TypeError('conflicting import');return {state:'ALREADY_IMPORTED',imported_at:prior.first_received_at,accessed_at:accessed??'UNKNOWN',confidence:'ADMINISTRATOR_ATTESTED_LOG',accessed_at_provenance:accessed?'AUTHORIZED_LOG_DECLARATION_NOT_INDEPENDENTLY_VERIFIED':'UNKNOWN',identity:'UNKNOWN'};}
    const times=(await client.query("SELECT $1::timestamptz IS NULL OR ($1::timestamptz>=clock_timestamp()-interval '7 days' AND $1::timestamptz<=clock_timestamp()) AS valid, EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='investigation_receipts'::regclass AND attname='accessed_at' AND NOT attisdropped) AS installed",[accessed])).rows[0];
    if(!times.valid || (accessed&&!times.installed))throw new TypeError('accessed_at unavailable or outside retention');
    if(Number((await client.query('SELECT count(*) AS n FROM investigation_receipts WHERE project_id=$1',[project])).rows[0].n)>=10000)throw new TypeError('capacity exceeded');
    const saved=await client.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,import_id${times.installed?',accessed_at':''})
      SELECT project_id,id,installation_id,'original_request',$3,$4,$5${times.installed?',$6::timestamptz':''} FROM protected_pages WHERE project_id=$1 AND id=$2 RETURNING first_received_at`,[project,value.page,value.source,value.resource,value.id,...(times.installed?[accessed]:[])]);
    return {state:'IMPORTED',imported_at:saved.rows[0].first_received_at,confidence:'ADMINISTRATOR_ATTESTED_LOG',accessed_at:accessed??'UNKNOWN',accessed_at_provenance:accessed?'AUTHORIZED_LOG_DECLARATION_NOT_INDEPENDENTLY_VERIFIED':'UNKNOWN',identity:'UNKNOWN'};
  });
}

// Passive complementary persistence: never grants mitigation or creates incidents.
export async function recordRuntimeReceipt(db:Pool,context:PageContext,resource:string,source:string,claimedHost?:string,alias?:string) {
  if(claimedHost && isIP(claimedHost.replace(/^\[|\]$/g,'')))claimedHost=undefined;
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    if(!(await client.query("SELECT to_regclass('investigation_receipts') IS NOT NULL AS installed")).rows[0].installed){await client.query('ROLLBACK');return;}
    if(!await operationallyEligible(client,context.project,context.page,true)){await client.query('ROLLBACK');return;}
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[context.project]);
    // Bounded minute buckets; saturation drops evidence, never asserts completeness.
    // Repeated buckets need neither cleanup nor a project-wide count scan.
    const prior=await client.query(`SELECT 1 FROM investigation_receipts WHERE project_id=$1 AND page_id=$2 AND kind='runtime_receipt' AND source=$3 AND resource=$4 AND COALESCE(claimed_host,'')=$5 AND COALESCE(alias,'00000000-0000-0000-0000-000000000000'::uuid)=$6::uuid AND bucket=date_trunc('minute',clock_timestamp())`,[context.project,context.page,source,resource,claimedHost??'',alias??'00000000-0000-0000-0000-000000000000']);
    if(prior.rowCount){await client.query('COMMIT');return;}
    await retainInvestigationReceipts(client,context.project);
    if(!prior.rowCount && Number((await client.query('SELECT count(*) AS n FROM investigation_receipts WHERE project_id=$1',[context.project])).rows[0].n)<10000)
      await client.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,claimed_host,alias)
        VALUES($1,$2,$3,'runtime_receipt',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[context.project,context.page,context.installation,source,resource,claimedHost??null,alias??null]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
// One complementary task per pool reserves the remaining connections for scripts
// and decisions. Pending work remains bounded; loss never implies completeness.
const queues=new WeakMap<Pool,{tail:Promise<void>;pending:number}>();
function scheduleReceipt(db:Pool,work:()=>Promise<void>) {
  if((db.options.max??10)<2)return;
  let queue=queues.get(db);if(!queue){queue={tail:Promise.resolve(),pending:0};queues.set(db,queue);}
  if(queue.pending>=100)return;
  const current=queue;current.pending++;
  const next=current.tail.then(work).catch(()=>{process.stderr.write('Investigation receipt unavailable; history may be incomplete\n');}).finally(()=>{current.pending--;});
  current.tail=next;return next;
}
export function receiveRuntimeReceipt(...args:Parameters<typeof recordRuntimeReceipt>) {
  return scheduleReceipt(args[0],()=>recordRuntimeReceipt(...args));
}
export function receiveDistributionScript(db:Pool,installation:string,resource:string,alias:string) {
  return scheduleReceipt(db,async()=>{const context=await resolvePageContext(db,installation);if(context)await recordRuntimeReceipt(db,context,resource,'distribution',undefined,alias);});
}
