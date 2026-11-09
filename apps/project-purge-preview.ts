import type { Pool } from 'pg';
export class ProjectPurgeConflict extends Error {}
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
type Table={oid:number;schema:string;name:string;project:boolean};
type ForeignKey={name:string;child:number;parent:number;columns:string[];targets:string[];definition:string};

// Intentionally no DELETE executor: retained audits/immutable evidence have not
// been authorized for erasure or detachment. This preview proves exact blockers.
export async function projectPurgePreview(db:Pool,data:Record<string,unknown>) {
 const project=data.project as string,preview=data.action==='preview-purge-project';
 if(Object.keys(data).sort().join(',')!==(preview?'action,project':'action,confirmation,justification,project,version')) throw new TypeError('invalid purge request');
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const row=(await client.query('SELECT id,name,lifecycle_state,lifecycle_version FROM projects WHERE id=$1 FOR UPDATE',[project])).rows[0];
  if(!row) throw new TypeError('unknown project');
  const confirmation='PURGE PROJECT '+project+':'+row.name;
  if(!preview) {
   if(row.lifecycle_state!=='ARCHIVED' || row.lifecycle_version!==data.version) throw new ProjectPurgeConflict('archive and refresh project version first');
   if(data.confirmation!==confirmation || typeof data.justification!=='string' || data.justification.trim().length<3 || data.justification.length>300) throw new TypeError('exact purge confirmation required');
  }
  const currentSchema=(await client.query("SELECT n.nspname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='projects'::regclass")).rows[0].name as string;
  const allTables=(await client.query(`SELECT c.oid::int, n.nspname AS schema,c.relname AS name,
    EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='project_id' AND NOT a.attisdropped) AS project
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows as Table[];
  const keys=(await client.query(`SELECT con.conname AS name,con.conrelid::int AS child,con.confrelid::int AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num ORDER BY k.pos) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num ORDER BY k.pos) AS targets,
    pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con WHERE con.contype='f' AND con.connamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema') ORDER BY con.conname`)).rows as ForeignKey[];
  const selected=new Set(allTables.filter(t=>t.schema===currentSchema).map(t=>t.oid));
  for(let changed=true;changed;) {changed=false;for(const fk of keys) if(selected.has(fk.parent) && !selected.has(fk.child)){selected.add(fk.child);changed=true;}}
  const tables=allTables.filter(t=>selected.has(t.oid));
  const byId=new Map(allTables.map(t=>[t.oid,t]));
  function scope(table:Table,alias:string,visited:number[]=[]):string|null {
   if(table.schema===currentSchema && table.name==='projects') return alias+'.id=$1';
   if(table.schema===currentSchema && table.project) return alias+'.project_id=$1';
   if(visited.includes(table.oid)) return null;
   const paths:string[]=[];
   for(const fk of keys.filter(k=>k.child===table.oid)) {
    const parent=byId.get(fk.parent);if(!parent)continue;
    const targetAlias='p'+[...visited,table.oid].length+'_'+paths.length;
    const predicate=scope(parent,targetAlias,[...visited,table.oid]);if(!predicate)continue;
    paths.push('EXISTS(SELECT 1 FROM '+quote(parent.schema)+'.'+quote(parent.name)+' '+targetAlias+' WHERE '+fk.columns.map((c,i)=>alias+'.'+quote(c)+'='+targetAlias+'.'+quote(fk.targets[i])).join(' AND ')+' AND ('+predicate+'))');
   }
   return paths.length?'('+paths.join(' OR ')+')':null;
  }
  const triggers=(await client.query(`SELECT c.oid::int AS table_oid,c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.oid=ANY($1::oid[]) ORDER BY c.relname,t.tgname`,[tables.map(t=>t.oid)])).rows;
  const inventory=[];const blockers:{table:string;reason:string;constraint?:string;rows?:number}[]=[];
  for(const table of tables){
   const predicate=scope(table,'t');
   let count:number|null=null;
   await client.query('SAVEPOINT dependency_count');
   try {count=(await client.query('SELECT count(*)::int n FROM '+quote(table.schema)+'.'+quote(table.name)+' t'+(predicate?' WHERE '+predicate:''),predicate?[project]:[])).rows[0].n as number;}
   catch(error) {if((error as {code?:string}).code!=='42501') throw error;await client.query('ROLLBACK TO SAVEPOINT dependency_count');blockers.push({table:table.schema+'.'+table.name,reason:'SELECT permission missing: dependency count and ownership cannot be proven'});}
   await client.query('RELEASE SAVEPOINT dependency_count');
   inventory.push({schema:table.schema,table:table.name,rows:count,scope:!predicate?'SHARED_OR_UNPROVEN':table.schema===currentSchema&&(table.project||table.name==='projects')?'PROJECT_KEY':'FK_REACHABLE_CANDIDATE',disposition:'RETAIN_UNTIL_PURGE_PROVEN'});
   if(table.schema!==currentSchema) blockers.push({table:table.schema+'.'+table.name,reason:'Cross-schema inbound dependency; external/shared ownership and purge are not authorized',...(count===null?{}:{rows:count})});
   if(predicate && count && triggers.some(t=>t.table_oid===table.oid && /immutable/.test(t.name))) blockers.push({table:table.name,reason:'Immutable evidence cannot be deleted or rewritten',rows:count});
   if(table.schema===currentSchema && predicate && count && ['project_lifecycle_audit','notification_pause_history','page_deletion_audit','checkout_sales','checkout_receipts','page_policy_review_audit'].includes(table.name)) blockers.push({table:table.name,reason:'Retained historical/financial records have no approved erasure or detached owner identity',rows:count});
  }
  const direct=keys.filter(fk=>byId.get(fk.parent)?.schema===currentSchema && byId.get(fk.parent)?.name==='projects');
  for(const fk of direct){const item=inventory.find(t=>t.schema===byId.get(fk.child)?.schema && t.table===byId.get(fk.child)?.name);if(item?.rows)blockers.push({table:item.schema===currentSchema?item.table:item.schema+'.'+item.table,constraint:fk.name,reason:fk.definition,rows:item.rows});}
  if(!blockers.length)blockers.push({table:'projects',reason:'No verified complete physical purge procedure; executor remains disabled'});
  if(!preview) throw new ProjectPurgeConflict('Physical project deletion is blocked; no verified executor is available');
  await client.query('COMMIT');
  return {project,version:row.lifecycle_version,state:row.lifecycle_state,confirmation,physicalDeletionAvailable:false,executed:false,blockers,inventory,foreignKeys:keys.filter(k=>selected.has(k.child)||selected.has(k.parent)).map(k=>({schema:byId.get(k.child)?.schema,table:byId.get(k.child)?.name,targetSchema:byId.get(k.parent)?.schema,target:byId.get(k.parent)?.name,...k})),triggers,sharedRecordsPolicy:'No unproven/shared record is deleted',backupPolicy:'Active-database deletion would not erase existing backups; backup retention and restore replay remain separate obligations'};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
