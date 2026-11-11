import type {PoolClient} from 'pg';

// Optional additive schema. Project and global metadata have independent bounds.
// Registration/configuration anchors remain; this expires change metadata only.
export async function retainAdministrativeChanges(client:PoolClient,project:string){
 if(!(await client.query("SELECT to_regclass('administrative_change_audit') IS NOT NULL installed")).rows[0].installed)return;
 await client.query("DELETE FROM administrative_change_audit WHERE (project_id=$1 OR project_id IS NULL) AND occurred_at<clock_timestamp()-interval '90 days'",[project]);
 for(const scope of [project,null])await client.query('DELETE FROM administrative_change_audit WHERE id IN (SELECT id FROM administrative_change_audit WHERE project_id IS NOT DISTINCT FROM $1 ORDER BY id DESC OFFSET 10000)',[scope]);
}
