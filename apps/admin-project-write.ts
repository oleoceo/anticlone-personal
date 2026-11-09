import type { Pool, PoolClient } from 'pg';

export class DeletedProjectConflict extends Error {}
// This lock is held through commit, serializing every administrative mutation
// with archive/delete/restore. Catalog absence only supports pre-tombstone installs.
export async function assertProjectAdministrativeWrite(client:PoolClient, project:string, mode:'UPDATE'|'SHARE'='UPDATE') {
  const row=(await client.query("SELECT id,to_jsonb(p)->>'deleted_at' AS deleted_at FROM projects p WHERE id=$1 FOR "+mode,[project])).rows[0];
  if (!row) throw new TypeError('unknown project');
  if (row.deleted_at) throw new DeletedProjectConflict('project is logically deleted');
}
export async function withProjectAdministrativeWrite<T>(db:Pool, project:string, write:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await db.connect();
  try {await client.query('BEGIN');await assertProjectAdministrativeWrite(client,project,'SHARE');const result=await write(client);await client.query('COMMIT');return result;}
  catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

export async function assertPageAdministrativeWrite(client:PoolClient, project:string,page:string) {
 const row=(await client.query("SELECT to_jsonb(p)->>'deleted_at' AS deleted_at FROM protected_pages p WHERE project_id=$1 AND id=$2 FOR UPDATE",[project,page])).rows[0];
 if(!row) throw new TypeError('unknown page');
 if(row.deleted_at) throw new DeletedProjectConflict('page is deleted');
}
