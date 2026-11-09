import type { Pool, PoolClient } from 'pg';
import { assertProjectAdministrativeWrite } from './admin-project-write.js';
export class PageDeletionConflict extends Error {}
const owned=[['page_cta_policy_bindings',true],['page_entry_policy_bindings',true],['page_installation_signals',true],['protected_page_urls',false]] as const;
async function dependencies(client:PoolClient, project:string, page:string) {
 const remove:Record<string,number>={},retain:Record<string,number>={};
 for(const [table,scoped] of owned) {
  const exists=(await client.query('SELECT to_regclass($1) IS NOT NULL AS installed',[table])).rows[0].installed;
  if(exists) remove[table]=(await client.query('SELECT count(*)::int n FROM '+table+' WHERE page_id=$1'+(scoped?' AND project_id=$2':''),scoped?[page,project]:[page])).rows[0].n;
 }
 for(const table of ['page_policy_approvals','page_policy_review_audit','page_deletion_audit']) {
  const exists=(await client.query('SELECT to_regclass($1) IS NOT NULL AS installed',[table])).rows[0].installed;
  if(exists) retain[table]=(await client.query('SELECT count(*)::int n FROM '+table+' WHERE page_id=$1 AND project_id=$2',[page,project])).rows[0].n;
 }
 const approvals=(await client.query("SELECT to_regclass('page_policy_approvals') IS NOT NULL AS installed")).rows[0].installed;
 if(approvals) for(const table of ['page_policy_approval_entries','page_policy_approval_ctas']) {
  if((await client.query('SELECT to_regclass($1) IS NOT NULL AS installed',[table])).rows[0].installed) retain[table]=(await client.query('SELECT count(*)::int n FROM '+table+' child JOIN page_policy_approvals a ON a.id=child.approval_id AND a.project_id=child.project_id WHERE a.page_id=$1 AND a.project_id=$2',[page,project])).rows[0].n;
 }
 const foreignKeys=(await client.query(`SELECT n.nspname AS schema,c.relname AS table_name,f.conname AS name,pg_get_constraintdef(f.oid) AS definition
  FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE f.contype='f' AND (f.confrelid='protected_pages'::regclass OR f.confrelid=to_regclass('page_policy_approvals')) ORDER BY n.nspname,c.relname,f.conname`)).rows;
 return {remove,retain,foreignKeys,unprovenDependenciesPolicy:'Retain all unlisted and shared dependencies; historical anchor is not physically deleted',sharedPolicy:'Project-level financial, incident, traffic and CTA records have no proven page ownership and are preserved',historicalPageAnchorRetained:true};
}
export async function deletePage(db:Pool, data:Record<string,unknown>) {
 const project=data.project as string,page=data.page as string,preview=data.action==='preview-delete-page';
 if(!['preview-delete-page','delete-page'].includes(data.action as string) || typeof page!=='string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(page) || Object.keys(data).sort().join(',')!==(preview?'action,page,project':'action,confirmation,justification,page,project,version')) throw new TypeError('invalid page deletion');
 if(!preview && (typeof data.version!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(data.version) || typeof data.justification!=='string' || data.justification.trim().length<3 || data.justification.length>300)) throw new TypeError('invalid page confirmation');
 const client=await db.connect();
 try {
  await client.query('BEGIN');
  if(preview) {if(!(await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[project])).rowCount) throw new TypeError('unknown project');}
  else await assertProjectAdministrativeWrite(client,project);
  const row=(await client.query('SELECT * FROM protected_pages WHERE project_id=$1 AND id=$2 FOR UPDATE',[project,page])).rows[0];
  if(!row) throw new TypeError('unknown page');
  const confirmation='DELETE PAGE '+project+'/'+page+'/'+row.name, inventory=await dependencies(client,project,page);
  if(preview) {await client.query('COMMIT');return {project,page,version:row.deletion_version,deletedAt:row.deleted_at,confirmation,...inventory};}
  if(row.deleted_at || row.deletion_version!==data.version) throw new PageDeletionConflict('page changed or already deleted');
  if(data.confirmation!==confirmation) throw new TypeError('exact page confirmation required');
  const urls=(await client.query('SELECT origin,pathname FROM protected_page_urls WHERE page_id=$1 ORDER BY origin,pathname',[page])).rows;
  const removed:Record<string,number>={};
  for(const [table,scoped] of owned) if(table in inventory.remove) removed[table]=(await client.query('DELETE FROM '+table+' WHERE page_id=$1'+(scoped?' AND project_id=$2':''),scoped?[page,project]:[page])).rowCount ?? 0;
  const result=(await client.query("UPDATE protected_pages SET deleted_at=clock_timestamp(),enabled=false,lifecycle_state='PAUSED' WHERE project_id=$1 AND id=$2 RETURNING deleted_at,deletion_version",[project,page])).rows[0];
  await client.query('INSERT INTO page_deletion_audit(project_id,page_id,justification,snapshot,removed) VALUES($1,$2,$3,$4,$5)',[project,page,data.justification,JSON.stringify({page:row,urls}),JSON.stringify(removed)]);
  await client.query('COMMIT');return {project,page,deletedAt:result.deleted_at,version:result.deletion_version,removed,historicalPageAnchorRetained:true,sharedRecordsPreserved:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
