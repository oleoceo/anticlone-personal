import { validateStealth } from './stealth.js';
import { assertProjectAdministrativeWrite, withProjectAdministrativeWrite } from './admin-project-write.js';
import type { Pool } from 'pg';
import { approvedDestination, configurationOrigin } from './page-redirect.js';

import { validateAllocation, type Allocation } from './allocation.js';

type Draft = {enabled: boolean; approved_destination: string; stealth: boolean; stealth_version?: number; allocation: Allocation};
export function validateDraft(body: unknown, origin: string): Draft {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid policy');
  const value = body as Record<string, unknown>;
  if (!['allocation,approved_destination,enabled,stealth','allocation,approved_destination,enabled,stealth,stealth_version'].includes(Object.keys(value).sort().join(',')) || typeof value.enabled !== 'boolean' || typeof value.stealth !== 'boolean' || typeof value.approved_destination !== 'string') throw Error('invalid or conflicting policy');
  if ('stealth_version' in value && value.stealth_version !== 2) throw Error('invalid stealth version');
  validateStealth(value as {stealth:boolean;stealth_version?:number});
  configurationOrigin(origin);
  return {enabled:value.enabled, approved_destination:approvedDestination(value.approved_destination, origin), stealth:value.stealth, ...(value.stealth_version == null ? {} : {stealth_version:value.stealth_version as number}), allocation:validateAllocation(value.allocation)};
}
export async function saveDraft(db: Pool, project: string, body: unknown) {
 return withProjectAdministrativeWrite(db,project,async client=>{
  const result = await client.query('SELECT origin FROM projects WHERE id=$1', [project]);
  if (!result.rowCount) throw Error('invalid project');
  const draft = validateDraft(body, result.rows[0].origin);
  if (draft.stealth_version === 2) {
    await client.query(`INSERT INTO protection_policy_drafts(project_id,enabled,approved_destination,stealth,allocation,stealth_version) VALUES($1,$2,$3,$4,$5,2) ON CONFLICT(project_id) DO UPDATE SET enabled=$2,approved_destination=$3,stealth=$4,allocation=$5,stealth_version=2`,[project,draft.enabled,draft.approved_destination,draft.stealth,JSON.stringify(draft.allocation)]);
    return;
  }
  const columns=await client.query("SELECT 1 FROM pg_attribute WHERE attrelid='protection_policy_drafts'::regclass AND attname='stealth_version' AND NOT attisdropped");
  await client.query(`INSERT INTO protection_policy_drafts(project_id,enabled,approved_destination,stealth,allocation) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(project_id) DO UPDATE SET enabled=$2,approved_destination=$3,stealth=$4,allocation=$5${columns.rowCount ? ",stealth_version=NULL" : ""}`, [project,draft.enabled,draft.approved_destination,draft.stealth,JSON.stringify(draft.allocation)]);
 });
}
export async function activatePolicy(db: Pool, project: string, version?: number) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,project);
    const row = await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE', [project]);
    if (!row.rowCount) throw Error('invalid project');
    if (version === undefined) {
      const drafts = await client.query(`SELECT enabled,approved_destination,stealth,allocation,to_jsonb(protection_policy_drafts)->'stealth_version' AS stealth_version FROM protection_policy_drafts WHERE project_id=$1 FOR UPDATE`, [project]);
      if (!drafts.rowCount) throw Error('missing draft');
      const draft = validateDraft(cleanVersion(drafts.rows[0]), row.rows[0].origin);
      const inserted = await client.query(`INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation${draft.stealth_version === 2 ? ",stealth_version" : ""})
        SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,$5${draft.stealth_version === 2 ? ",2" : ""} FROM protection_policy_versions WHERE project_id=$1 RETURNING version`, [project,draft.enabled,draft.approved_destination,draft.stealth,JSON.stringify(draft.allocation)]);
      version = inserted.rows[0].version as number;
    } else {
      if (!Number.isSafeInteger(version) || version < 1) throw Error('invalid version');
      const found = await client.query(`SELECT enabled,approved_destination,stealth,allocation,to_jsonb(protection_policy_versions)->'stealth_version' AS stealth_version FROM protection_policy_versions WHERE project_id=$1 AND version=$2`, [project,version]);
      if (!found.rowCount) throw Error('invalid version');
      validateDraft(cleanVersion(found.rows[0]), row.rows[0].origin);
    }
    await client.query(`INSERT INTO active_protection_policies VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET version=EXCLUDED.version`, [project,version]);
    await client.query('COMMIT'); return version;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function cleanVersion(row:Record<string,unknown>) { const copy={...row}; if(copy.stealth_version == null) delete copy.stealth_version; return copy; }
