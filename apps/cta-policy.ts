import { permitsMitigation, validateStealth, assertCtaStealthCompatibility, type StealthPolicy } from './stealth.js';
import type { RiskAssessment } from './risk.js';
import { assertProjectAdministrativeWrite } from './admin-project-write.js';
import type { Pool, PoolClient } from 'pg';
import { validateAllocation, selected } from './allocation.js';
import { approvedDestination, configurationOrigin } from './page-redirect.js';

type Policy = {version:number; enabled:boolean; surface:string; pathname:string; allocation:unknown} & StealthPolicy;
function validate(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid policy');
  const p = body as Record<string,unknown>;
  if (!['allocation,enabled,pathname,surface','allocation,enabled,pathname,stealth,stealth_version,surface'].includes(Object.keys(p).sort().join(',')) || typeof p.enabled !== 'boolean' || typeof p.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.surface) || typeof p.pathname !== 'string' || !/^\/[a-zA-Z0-9/_-]{0,200}$/.test(p.pathname)) throw Error('invalid policy');
  if ('stealth_version' in p && p.stealth_version !== 2) throw Error('invalid stealth version');
  validateStealth(p as StealthPolicy);
  return {...(p.stealth_version == null ? {} : {stealth:p.stealth as boolean,stealth_version:p.stealth_version as number}),enabled:p.enabled,surface:p.surface,pathname:p.pathname,allocation:validateAllocation(p.allocation)};
}
export async function publishCtaPolicy(db:Pool, project:string, body:unknown) {
  const p=validate(body), client=await db.connect();
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,project);
    const projectRow=await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[project]);
    if (!projectRow.rowCount) throw Error('invalid project');
    configurationOrigin(projectRow.rows[0].origin);
    const existing=await client.query('SELECT 1 FROM active_cta_surface_policies a JOIN cta_policy_versions v USING(project_id,version) WHERE a.project_id=$1 AND a.surface=$2 AND v.pathname<>$3 LIMIT 1',[project,p.surface,p.pathname]);
    if (existing.rowCount) {
      const schema=await client.query("SELECT to_regclass('page_cta_policy_bindings') IS NOT NULL AS available");
      if (!schema.rows[0].available) throw Error('surface already bound to another pathname');
      const migration=await client.query(`SELECT 1 FROM page_cta_policy_bindings b JOIN protected_pages p ON p.id=b.page_id AND p.project_id=b.project_id JOIN protected_page_urls u ON u.page_id=p.id WHERE b.project_id=$1 AND b.surface=$2 AND p.url_review_required AND u.pathname=$3 AND (SELECT count(*) FROM protected_page_urls WHERE page_id=p.id)=1`,[project,p.surface,p.pathname]);
      if (!migration.rowCount) throw Error('surface already bound to another pathname');
    }
    const result=await client.query(`INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation${p.stealth_version === 2 ? ",stealth,stealth_version" : ""})
      SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,$5${p.stealth_version === 2 ? (p.stealth ? ",true,2" : ",false,2") : ""} FROM cta_policy_versions WHERE project_id=$1 RETURNING version`,[project,p.enabled,p.surface,p.pathname,JSON.stringify(p.allocation)]);
    const version=result.rows[0].version as number;
    await client.query('INSERT INTO active_cta_surface_policies(project_id,surface,version) VALUES($1,$2,$3) ON CONFLICT(project_id,surface) DO UPDATE SET version=EXCLUDED.version',[project,p.surface,version]);
    await client.query('COMMIT'); return version;
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function ctaDecision(db:Pool, project:string, original:string, origin:string, controlledOrigin:string|undefined, risk:string, session:unknown, trafficClass:string, pathname?:string, observedPathname?:string, pageId?:string, snapshotClient?:PoolClient, assessment?:RiskAssessment): Promise<{action:string;stealthVersion?:number;ctaVersion?:number;version?:number;pathname?:string;original?:string;mappings?:{marker:string;kind:string;destination:string;surface?:string;requiresSurface?:boolean}[];externalDestinations?:string[]}> {
  if (origin===original || !controlledOrigin || origin!==controlledOrigin) return {action:'OBSERVE_ONLY'};
  const client=snapshotClient ?? await db.connect().catch(()=>undefined);
  if (!client) return {action:'OBSERVE_ONLY'};
  try {
    if (!snapshotClient) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const policies=pageId ? await client.query(`SELECT v.version,v.enabled,v.surface,v.pathname,v.allocation,to_jsonb(v)->'stealth' AS stealth,to_jsonb(v)->'stealth_version' AS stealth_version FROM active_cta_surface_policies a JOIN cta_policy_versions v ON v.project_id=a.project_id AND v.version=a.version JOIN page_cta_policy_bindings b ON b.project_id=a.project_id AND b.surface=a.surface AND b.version=a.version WHERE a.project_id=$1 AND b.page_id=$2 ORDER BY v.version`,[project,pageId]) : await client.query(`SELECT v.version,v.enabled,v.surface,v.pathname,v.allocation,to_jsonb(v)->'stealth' AS stealth,to_jsonb(v)->'stealth_version' AS stealth_version FROM active_cta_surface_policies a JOIN cta_policy_versions v ON v.project_id=a.project_id AND v.version=a.version WHERE a.project_id=$1 ORDER BY v.version`,[project]);
    const all=policies.rows as Policy[];
    if (!all.length) return {action:'OBSERVE_ONLY'};
    const version=Math.max(...all.map(p=>p.version));
    const path=pathname ?? all[0].pathname;
    if (!/^\/[a-zA-Z0-9/_-]{0,200}$/.test(path)) return {action:'OBSERVE_ONLY',ctaVersion:version};
    if (observedPathname !== undefined && !/^\/[a-zA-Z0-9/_-]{0,200}$/.test(observedPathname)) return {action:'OBSERVE_ONLY',ctaVersion:version};
    assertCtaStealthCompatibility(all.filter(policy=>policy.pathname===path && policy.enabled));
    const selectedPolicies=all.filter(policy=>policy.pathname===path && permitsMitigation(policy,risk,assessment) && validate(policyWithoutVersion(policy)).enabled && selected(session,'REPLACE_CONVERSION',policy.version,validateAllocation(policy.allocation),trafficClass));
    if (!selectedPolicies.length) return {action:'OBSERVE_ONLY',ctaVersion:version};
    const rows=await client.query(`SELECT p.surface,p.marker,p.kind,d.url FROM cta_points p JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id AND m.offer=p.offer JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 AND p.surface=ANY($2::text[]) AND p.kind='a' AND p.marker IS NOT NULL AND p.review_required=false AND r.suspension IS NULL ORDER BY p.id LIMIT 101`,[project,selectedPolicies.map(p=>p.surface)]);
    if (rows.rows.length>100) return {action:'OBSERVE_ONLY',ctaVersion:version};
    const collisions=await client.query(`SELECT marker FROM cta_points WHERE project_id=$1 AND surface=ANY($2::text[]) AND marker IS NOT NULL GROUP BY marker HAVING count(*)>1`,[project,all.filter(p=>p.pathname===path).map(p=>p.surface)]);
    const ambiguous=new Set(collisions.rows.map((row:{marker:string})=>row.marker));
    const multipleSurfaces=all.length>1;
    const mappings: {surface:string;marker:string;kind:string;destination:string;requiresSurface:boolean}[]=[];
    for (const row of rows.rows as {surface:string;marker:string;kind:string;url:string}[]) {
      try { mappings.push({surface:row.surface,marker:row.marker,kind:row.kind,destination:approvedDestination(row.url,original),requiresSurface:multipleSurfaces || ambiguous.has(row.marker)}); }
      catch { /* An unavailable approval suspends this point, not independent points. */ }
    }
    const externalDestinations=mappings.filter(row=>new URL(row.destination).origin!==original).map(row=>row.destination);
    return {action:'REPLACE_CONVERSION',...(selectedPolicies.every(p=>p.stealth_version===2)?{stealthVersion:2}:{}),version,pathname:observedPathname ?? path,original,mappings,...(externalDestinations.length?{externalDestinations}:{})};
  } catch { return {action:'OBSERVE_ONLY'}; }
  finally { if (!snapshotClient) { try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); } } }
}
function policyWithoutVersion(p:Policy) { return {...(p.stealth_version == null ? {} : {stealth:p.stealth,stealth_version:p.stealth_version}),enabled:p.enabled,surface:p.surface,pathname:p.pathname,allocation:p.allocation}; }
