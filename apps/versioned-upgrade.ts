import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import type {Pool} from 'pg';

// This API is intentionally restricted to disposable databases. Adopting an
// existing production schema/ledger requires a separate, approved procedure.
export async function upgradeLaboratory(db:Pool,directory='infra',through=999) {
 const client=await db.connect();
 try{
  const name=(await client.query('SELECT current_database() AS name')).rows[0].name as string;
  if(!/^anticlone_(upgrade|restore)_[a-z0-9_]{1,40}$/.test(name))throw new Error('isolated upgrade database required');
  await client.query('SELECT pg_advisory_lock(7933,60)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migration_ledger(version integer PRIMARY KEY,name text NOT NULL,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  const files=(await readdir(directory)).filter(f=>/^\d{3}_.+\.sql$/.test(f)).sort();
  const applied:number[]=[];
  for(const file of files){
   const version=Number(file.slice(0,3));if(version>through)continue;
   const source=(await readFile(directory+'/'+file,'utf8')).replace(/^\uFEFF/,'').replaceAll('\r\n','\n');const sha=createHash('sha256').update(source).digest('hex');
   const prior=(await client.query('SELECT name,sha256 FROM schema_migration_ledger WHERE version=$1',[version])).rows[0];
   if(prior){if(prior.name!==file||prior.sha256!==sha)throw Error('migration checksum mismatch');continue;}
   // Repository migrations use optional outer transaction markers. Keep every
   // statement and ledger entry in ONE transaction, even on injected failure.
   const sql=source.replace(/^[ \t]*(?:BEGIN|COMMIT);[ \t]*$/gm,'');
   await client.query('BEGIN');
   try{await client.query(sql);await client.query('INSERT INTO schema_migration_ledger(version,name,sha256) VALUES($1,$2,$3)',[version,file,sha]);await client.query('COMMIT');applied.push(version);}
   catch(error){await client.query('ROLLBACK');throw error;}
  }
  return {applied};
 }finally{try{await client.query('SELECT pg_advisory_unlock(7933,60)');}finally{client.release();}}
}
