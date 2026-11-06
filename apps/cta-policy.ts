import type { Pool } from 'pg';
import { validateAllocation, selected } from './allocation.js';
import { approvedDestination } from './page-redirect.js';

type Policy = {version:number; enabled:boolean; surface:string; pathname:string; allocation:unknown};
function validate(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid policy');
  const p = body as Record<string,unknown>;
  if (Object.keys(p).sort().join(',') !== 'allocation,enabled,pathname,surface' || typeof p.enabled !== 'boolean' || typeof p.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.surface) || typeof p.pathname !== 'string' || !/^\/[a-zA-Z0-9/_-]{0,200}$/.test(p.pathname)) throw Error('invalid policy');
  return {enabled:p.enabled,surface:p.surface,pathname:p.pathname,allocation:validateAllocation(p.allocation)};
}
export async function publishCtaPolicy(db:Pool, project:string, body:unknown) {
  const p=validate(body), client=await db.connect();
  try {
    await client.query('BEGIN');
    const projectRow=await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[project]);
    if (!projectRow.rowCount || !['localhost','127.0.0.1'].includes(new URL(projectRow.rows[0].origin).hostname)) throw Error('laboratory only');
    const result=await client.query(`INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation)
      SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,$5 FROM cta_policy_versions WHERE project_id=$1 RETURNING version`,[project,p.enabled,p.surface,p.pathname,JSON.stringify(p.allocation)]);
    const version=result.rows[0].version as number;
    await client.query('INSERT INTO active_cta_policies VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET version=EXCLUDED.version',[project,version]);
    await client.query('COMMIT'); return version;
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function ctaDecision(db:Pool, project:string, original:string, origin:string, controlledOrigin:string|undefined, risk:string, session:unknown, trafficClass:string): Promise<{action:string;ctaVersion?:number;version?:number;pathname?:string;original?:string;mappings?:{marker:string;kind:string;destination:string}[];externalDestinations?:string[]}> {
  if (origin===original || !controlledOrigin || origin!==controlledOrigin || risk!=='LOW') return {action:'OBSERVE_ONLY'};
  const client=await db.connect().catch(()=>undefined);
  if (!client) return {action:'OBSERVE_ONLY'};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const policies=await client.query(`SELECT v.version,v.enabled,v.surface,v.pathname,v.allocation FROM active_cta_policies a JOIN cta_policy_versions v ON v.project_id=a.project_id AND v.version=a.version WHERE a.project_id=$1`,[project]);
    const policy=policies.rows[0] as Policy|undefined;
    if (!policy) return {action:'OBSERVE_ONLY'};
    if (!Number.isSafeInteger(policy.version) || policy.version < 1) return {action:'OBSERVE_ONLY'};
    if (!validate(policyWithoutVersion(policy)).enabled || !selected(session,'REPLACE_CONVERSION',policy.version,validateAllocation(policy.allocation),trafficClass)) return {action:'OBSERVE_ONLY',ctaVersion:policy.version};
    const rows=await client.query(`SELECT p.marker,p.kind,d.url FROM cta_points p JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id AND m.offer=p.offer JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 AND p.surface=$2 AND p.kind='a' AND p.marker IS NOT NULL AND p.review_required=false AND r.suspension IS NULL ORDER BY p.id LIMIT 101`,[project,policy.surface]);
    if (rows.rows.length>100) return {action:'OBSERVE_ONLY'};
    const mappings=rows.rows.map((row:{marker:string;kind:string;url:string})=>({marker:row.marker,kind:row.kind,destination:approvedDestination(row.url,original)}));
    const externalDestinations=mappings.filter(row=>new URL(row.destination).origin!==original).map(row=>row.destination);
    return {action:'REPLACE_CONVERSION',version:policy.version,pathname:policy.pathname,original,mappings,...(externalDestinations.length?{externalDestinations}:{})};
  } catch { return {action:'OBSERVE_ONLY'}; }
  finally { try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); } }
}
function policyWithoutVersion(p:Policy) { return {enabled:p.enabled,surface:p.surface,pathname:p.pathname,allocation:p.allocation}; }
