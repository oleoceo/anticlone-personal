import type { Pool } from 'pg';

export class LifecycleConflict extends Error {}
const actions=new Set(['lifecycle-status','preview-delete-project','archive-project','restore-project','delete-project']);
export function isLifecycleAction(action:string) {return actions.has(action);}

// Called only through the existing authenticated/CSRF-protected admin pages route.
// "Delete" is a reversible tombstone; this module never issues DELETE.
export async function projectLifecycle(db:Pool, data:Record<string,unknown>) {
  const project=data.project as string, action=data.action as string;
  const read=action==='lifecycle-status' || action==='preview-delete-project';
  const expectedKeys=read ? 'action,project' : action==='delete-project' ? 'action,confirmation,justification,project,version' : 'action,justification,project,version';
  if (!actions.has(action) || Object.keys(data).sort().join(',')!==expectedKeys) throw new TypeError('invalid lifecycle request');
  if (!read && (typeof data.version!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(data.version) || BigInt(data.version)>9223372036854775807n || typeof data.justification!=='string' || data.justification.trim().length<3 || data.justification.length>300 || /[\u0000-\u001f\u007f]/.test(data.justification))) throw new TypeError('invalid lifecycle confirmation');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query('SELECT id,name,lifecycle_state,lifecycle_version,deleted_at FROM projects WHERE id=$1 FOR UPDATE',[project])).rows[0];
    if (!row) throw new TypeError('unknown project');
    if (read) {
      const audit=await client.query('SELECT id,occurred_at,previous_state,current_state,previous_deleted_at,current_deleted_at,previous_version,current_version,actor,justification FROM project_lifecycle_audit WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[project]);
      // These are project-local reference counts, not a promise of physical purge.
      const inventory:Record<string,number>={};
      if (action==='preview-delete-project') for(const table of ['protected_pages','incidents','observations','health_episodes','cta_drift_alerts','checkout_receipts']) {
        const installed=(await client.query('SELECT to_regclass($1) IS NOT NULL AS installed',[table])).rows[0].installed;
        if (installed) inventory[table]=(await client.query('SELECT count(*)::int n FROM '+table+' WHERE project_id=$1',[project])).rows[0].n;
      }
      await client.query('COMMIT');
      return {project,state:row.lifecycle_state,version:row.lifecycle_version,name:row.name,deletedAt:row.deleted_at,audit:audit.rows,inventory,deleteMode:'REVERSIBLE_LOGICAL',physicalDeletionAvailable:false,notificationBacklogResolutionAvailable:false,confirmation:action==='preview-delete-project' ? project+':'+row.name : undefined};
    }
    if (row.lifecycle_version!==data.version) throw new LifecycleConflict('stale lifecycle version');
    let next:string;let deleting=false;
    if (action==='archive-project') {
      if (row.deleted_at || !['ACTIVE','PAUSED'].includes(row.lifecycle_state)) throw new LifecycleConflict('project cannot be archived');
      next='ARCHIVED';
    } else if (action==='restore-project') {
      if (row.lifecycle_state!=='ARCHIVED') throw new LifecycleConflict('only archived projects can be restored');
      next='PAUSED'; // Restore never re-enables gateways or replays a queue.
    } else {
      if (row.lifecycle_state!=='ARCHIVED' || row.deleted_at) throw new LifecycleConflict('archive project before logical deletion');
      if (data.confirmation!==project+':'+row.name) throw new TypeError('project name and identity confirmation required');
      next='ARCHIVED'; deleting=true;
    }
    await client.query("SELECT set_config('anticlone.lifecycle_reason',$1,true)",[data.justification]);
    const updated=(await client.query('UPDATE projects SET lifecycle_state=$2,deleted_at=CASE WHEN $3 THEN clock_timestamp() END WHERE id=$1 RETURNING lifecycle_state,lifecycle_version,deleted_at',[project,next,deleting])).rows[0];
    await client.query('COMMIT');
    return {project,state:updated.lifecycle_state,version:updated.lifecycle_version,deletedAt:updated.deleted_at,deleteMode:'REVERSIBLE_LOGICAL',physicalDeletionAvailable:false,notificationBacklogResolutionAvailable:false};
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
