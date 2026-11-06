import type { Pool } from 'pg';
import { validateDraft, activatePolicy } from './protection-policy.js';
import { publishCtaPolicy } from './cta-policy.js';
import { approveDestination, mapPoint, reviewPoint } from './cta-inventory.js';
import { externalDestinations, configurationOrigin } from './page-redirect.js';

// Publish the exact form snapshot, not a draft another admin tab may have replaced.
export async function publishPagePolicy(db: Pool, project: string, body: unknown) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE', [project]);
    if (!row.rowCount) throw new TypeError('invalid project');
    const draft = validateDraft(body, row.rows[0].origin);
    const inserted = await client.query(`INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation)
      SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,$5 FROM protection_policy_versions WHERE project_id=$1 RETURNING version`, [project,draft.enabled,draft.approved_destination,draft.stealth,JSON.stringify(draft.allocation)]);
    const version = inserted.rows[0].version as number;
    await client.query('INSERT INTO active_protection_policies VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET version=EXCLUDED.version', [project,version]);
    await client.query('COMMIT');
    return {version};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function protectionAdmin(db: Pool, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('invalid protection request');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'action,data,project' || typeof input.project !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.project) || typeof input.action !== 'string') throw new TypeError('invalid protection request');
  const project = input.project;
  try {
    const found = await db.query('SELECT id,name,origin FROM projects WHERE id=$1', [project]);
    if (!found.rowCount) throw new TypeError('invalid project');
    configurationOrigin(found.rows[0].origin);
    if (input.action === 'inspect') {
      if (input.data !== null) throw new TypeError('invalid inspection');
      const page = await db.query('SELECT v.* FROM active_protection_policies a JOIN protection_policy_versions v USING(project_id,version) WHERE a.project_id=$1',[project]);
      const cta = await db.query('SELECT v.* FROM active_cta_policies a JOIN cta_policy_versions v USING(project_id,version) WHERE a.project_id=$1',[project]);
      const destinations = await db.query('SELECT id,offer,url FROM cta_destinations WHERE project_id=$1 ORDER BY offer,id LIMIT 1000',[project]);
      const versions = await db.query('SELECT version,enabled,approved_destination,allocation FROM protection_policy_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 20',[project]);
      return {project:found.rows[0],page:page.rows[0]??null,cta:cta.rows[0]??null,destinations:destinations.rows,versions:versions.rows,externalDestinations:externalDestinations(found.rows[0].origin)};
    }
    if (input.action === 'page-publish') return publishPagePolicy(db,project,input.data);
    if (input.action === 'cta-publish') return {version:await publishCtaPolicy(db,project,input.data)};
    if (input.action === 'destination') return approveDestination(db,project,input.data);
    if (input.action === 'map') { await mapPoint(db,project,input.data); return {state:'MAPPED'}; }
    if (input.action === 'review') { await reviewPoint(db,project,input.data); return {state:'REVIEWED'}; }
    if (input.action === 'page-activate') {
      if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data) || Object.keys(input.data).join(',') !== 'version' || !Number.isSafeInteger((input.data as {version:unknown}).version)) throw new TypeError('invalid version');
      return {version:await activatePolicy(db,project,(input.data as {version:number}).version)};
    }
    throw new TypeError('invalid protection action');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw new TypeError('invalid protection configuration');
  }
}
