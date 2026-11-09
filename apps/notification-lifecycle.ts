import type { Pool, PoolClient } from 'pg';
import { operationallyEligible } from './operational-eligibility.js';

// Caller owns a transaction. Project SHARE is the admission boundary with pause.
// No network I/O may happen until that transaction has committed.
export async function notificationAdmission(client: PoolClient, project: string): Promise<string | null | false> {
  if (!await operationallyEligible(client,project,undefined,true)) return false;
  const installed=await client.query("SELECT to_regclass('notification_pause_history') IS NOT NULL AS installed");
  if (!installed.rows[0].installed) {
    const lifecycle=await client.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='projects'::regclass AND attname='lifecycle_state' AND NOT attisdropped) AS installed");
    if (lifecycle.rows[0].installed) throw new Error('notification lifecycle migration required');
    return null; // Pre-lifecycle installations have never supported pause.
  }
  const result=await client.query('SELECT max(occurred_at)::text AS cutoff FROM notification_pause_history WHERE project_id=$1',[project]);
  return result.rows[0].cutoff;
}

// Used inside retention transactions after locking the project row.
export async function notificationRetention(db: Pool | PoolClient, project: string) {
  const active=await operationallyEligible(db,project,undefined,true);
  const installed=await db.query("SELECT to_regclass('notification_pause_history') IS NOT NULL AS installed");
  const cutoff=installed.rows[0].installed ? (await db.query('SELECT max(occurred_at)::text AS cutoff FROM notification_pause_history WHERE project_id=$1',[project])).rows[0].cutoff as string|null : null;
  return {active,cutoff};
}
