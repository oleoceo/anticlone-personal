import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export class InstallationOriginConflict extends Error {}

// Browser claims are forgeable. They are not controlled checks or proof of installation.
export async function recordInstallationClaim(db: Pool, project: string, origin: string, source: 'core' | 'fallback'): Promise<void> {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    const allowed=await client.query(`SELECT i.project_id FROM installations i JOIN projects p ON p.id=i.project_id
      WHERE i.project_id=$1 AND i.origin=$2 AND p.origin=i.origin AND i.enabled FOR UPDATE OF i`,[project,origin]);
    if (allowed.rowCount) await client.query(`INSERT INTO installation_signals(project_id,source) VALUES($1,$2)
      ON CONFLICT (project_id,source) DO UPDATE SET last_observed_at=clock_timestamp()`,[project,source]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function enableInstallation(db: Pool, project: string) {
  const result = await db.query(`INSERT INTO installations(project_id,id,origin)
    SELECT id,$2,origin FROM projects WHERE id=$1
    ON CONFLICT (project_id) DO UPDATE SET enabled=true WHERE installations.origin=excluded.origin RETURNING id`, [project,randomUUID()]);
  if (!result.rowCount) {
    const existing = await db.query('SELECT id FROM installations WHERE project_id=$1', [project]);
    if (!existing.rowCount) throw new TypeError('unknown project');
    throw new InstallationOriginConflict('installation origin differs from current project origin');
  }
  return installationDiagnostic(db,project);
}

export async function disableInstallation(db: Pool, project: string) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 45)',[project]);
    await client.query('UPDATE installations SET enabled=false WHERE project_id=$1',[project]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return installationDiagnostic(db,project);
}

export async function installationDiagnostic(db: Pool, project: string) {
  const result = await db.query(`SELECT i.id,i.origin,i.enabled,i.created_at,p.origin AS current_origin,
    s.source,s.last_observed_at FROM installations i JOIN projects p ON p.id=i.project_id
    LEFT JOIN installation_signals s ON s.project_id=i.project_id AND s.last_observed_at >= now()-interval '7 days' WHERE i.project_id=$1 ORDER BY s.source`, [project]);
  if (!result.rowCount) return {installation:null,status:'NOT_VERIFIED',signals:[],controlledCheck:null};
  const row = result.rows[0];
  return {installation:{id:row.id,origin:row.origin,enabled:row.enabled,createdAt:row.created_at,originMatches:row.origin===row.current_origin},
    status:'NOT_VERIFIED',controlledCheck:null,signals:result.rows.filter(r=>r.source).map(r=>({source:r.source,lastObservedAt:r.last_observed_at,confidence:'UNAUTHENTICATED_CLAIM'}))};
}
