import type {Pool,PoolClient} from 'pg';
import {assertPageAdministrativeWrite,withProjectAdministrativeWrite} from './admin-project-write.js';
import {resolvePageContext,type PageContext} from './page-context.js';
import {operationallyEligible} from './operational-eligibility.js';
import type {IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
export const receiptAliases=new WeakMap<IncomingMessage,string>();

const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export async function retainInvestigationReceipts(db:Pool|PoolClient,project:string) {
  if (!(await db.query("SELECT to_regclass('investigation_receipts') IS NOT NULL AS installed")).rows[0].installed)return;
  await db.query("DELETE FROM investigation_receipts WHERE project_id=$1 AND last_received_at<clock_timestamp()-interval '7 days'",[project]);
}
// Import is an authenticated administrator assertion about an authorized log.
// Import time is server time, deliberately never represented as original access time.
export async function importOriginalRequest(db:Pool,project:string,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid import');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='authorized,id,page,resource,source' || value.authorized!==true || typeof value.id!=='string'||!uuid.test(value.id)||typeof value.page!=='string'||!uuid.test(value.page)||!['HTML','SCRIPT','STYLE','IMAGE','OTHER'].includes(value.resource as string)||!['owned_access_log','authorized_provider_log'].includes(value.source as string))throw new TypeError('invalid import');
  return withProjectAdministrativeWrite(db,project,async client=>{
    await assertPageAdministrativeWrite(client,project,value.page as string);
    if(!await operationallyEligible(client,project,value.page as string,true))throw new TypeError('inactive context');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[project]);
    await retainInvestigationReceipts(client,project);
    const prior=(await client.query('SELECT page_id,resource,source FROM investigation_receipts WHERE project_id=$1 AND import_id=$2',[project,value.id])).rows[0];
    if(prior){if(prior.page_id!==value.page||prior.resource!==value.resource||prior.source!==value.source)throw new TypeError('conflicting import');return {state:'ALREADY_IMPORTED'};}
    if(Number((await client.query('SELECT count(*) AS n FROM investigation_receipts WHERE project_id=$1',[project])).rows[0].n)>=10000)throw new TypeError('capacity exceeded');
    await client.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,import_id)
      SELECT project_id,id,installation_id,'original_request',$3,$4,$5 FROM protected_pages WHERE project_id=$1 AND id=$2`,[project,value.page,value.source,value.resource,value.id]);
    return {state:'IMPORTED',confidence:'ADMINISTRATOR_ATTESTED_LOG',access_time:'UNKNOWN',identity:'UNKNOWN'};
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
    await retainInvestigationReceipts(client,context.project);
    // Bounded minute buckets; saturation drops evidence, never asserts completeness.
    if(Number((await client.query('SELECT count(*) AS n FROM investigation_receipts WHERE project_id=$1',[context.project])).rows[0].n)<10000)
      await client.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,claimed_host,alias)
        VALUES($1,$2,$3,'runtime_receipt',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[context.project,context.page,context.installation,source,resource,claimedHost??null,alias??null]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
let pending=0;
export function receiveRuntimeReceipt(...args:Parameters<typeof recordRuntimeReceipt>) {
  if(pending>=100)return;
  pending++;
  void recordRuntimeReceipt(...args).catch(()=>process.stderr.write('Investigation receipt unavailable; history may be incomplete\n')).finally(()=>{pending--;});
}
export function receiveDistributionScript(db:Pool,installation:string,resource:string,alias:string) {
  if(pending>=100)return;
  pending++;
  void resolvePageContext(db,installation).then(context=>context?recordRuntimeReceipt(db,context,resource,'distribution',undefined,alias):undefined)
    .catch(()=>process.stderr.write('Investigation script receipt unavailable; history may be incomplete\n')).finally(()=>{pending--;});
}
