import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assertProjectAdministrativeWrite, assertPageAdministrativeWrite } from './admin-project-write.js';

export const distributionRoles = ['SCRIPT','TELEMETRY','STATIC_ASSETS'] as const;
type Role = typeof distributionRoles[number];
export type Distribution = {installation:string; version:number; bases:Record<Role,string>;paths?:Record<string,string>};
export const neutralPaths:Record<string,string>={'runtime.js':'a.js','core.js':'b.js','fallback.js':'c.js','observe':'e','observe/fallback':'f','entry-decision':'g','cta-refresh':'h','observed-session':'j','observed-action':'k','html.gif':'m.gif','css.gif':'n.gif','cta-inventory.js':'p.js'};
type AliasRow = {alias:string;installation_id:string;version:number;role:Role;origin:string;contract_version:number};

// Configuration is private and operator-owned; never infer origins from a request.
export function distributionOrigins(env:NodeJS.ProcessEnv):Record<Role,string> {
  const fallback=env.RUNTIME_PUBLIC_ORIGIN;
  const origins={} as Record<Role,string>;
  for (const role of distributionRoles) {
    const value=env['RUNTIME_'+role+'_ORIGIN'] ?? fallback;
    if (!value || value.length>2048 || /[\s\\<>"']/.test(value)) throw new TypeError('runtime public origin required');
    const url=new URL(value);
    if (url.origin!==value || url.username || url.password || url.hostname.endsWith('.') ||
      (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new TypeError('invalid runtime origin');
    if (env.ADMIN_PUBLIC_ORIGIN && new URL(env.ADMIN_PUBLIC_ORIGIN).hostname===url.hostname) throw new TypeError('runtime and admin hostnames must differ');
    origins[role]=value;
  }
  return origins;
}
function fromRows(rows:AliasRow[]):Distribution|null {
  if (rows.length!==3 || new Set(rows.map(row=>row.role)).size!==3) return null;
  return {installation:rows[0].installation_id,version:rows[0].version,
    ...(rows[0].contract_version===2?{paths:neutralPaths}:{}),
    bases:Object.fromEntries(rows.map(row=>[row.role,row.origin+(row.contract_version===2?'/r/v2/':'/d/v1/')+row.alias+'/'])) as Record<Role,string>};
}
export async function readDistribution(db:Pool|PoolClient,installation:string,version?:number) {
  const rows=await db.query<AliasRow>(`SELECT a.*,d.contract_version FROM runtime_aliases a JOIN runtime_distributions d USING(installation_id,version) WHERE a.installation_id=$1 AND a.version=COALESCE($2,(SELECT max(version) FROM runtime_distributions WHERE installation_id=$1)) ORDER BY role`,[installation,version??null]);
  return fromRows(rows.rows);
}
export function distributionSnippets(distribution:Distribution) {
  const {bases}=distribution;
  const path=(name:string)=>distribution.paths?.[name]??name;
  return {html:`<script async src="${bases.SCRIPT}${path('runtime.js')}"></script>\n<script async src="${bases.SCRIPT}${path('fallback.js')}"></script>\n<img src="${bases.STATIC_ASSETS}${path('html.gif')}" width="1" height="1" alt="" referrerpolicy="strict-origin-when-cross-origin">`,
    css:`/* Aplique a classe a um elemento existente. Sinal passivo; sem mitigação. */\n.anticlone-canary { background-image: url("${bases.STATIC_ASSETS}${path('css.gif')}"); }`};
}
export async function distributionAdmin(db:Pool,body:unknown,env=process.env) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new TypeError('invalid distribution');
  const data=body as Record<string,unknown>;
  if (Object.keys(data).sort().join(',')!=='action,page,project' || typeof data.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) || typeof data.page!=='string' || !/^[a-f0-9-]{36}$/i.test(data.page) || !['inspect','publish','rotate'].includes(String(data.action))) throw new TypeError('invalid distribution');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    if (data.action!=='inspect') { await assertProjectAdministrativeWrite(client,data.project,'SHARE'); await assertPageAdministrativeWrite(client,data.project,data.page); }
    const page=(await client.query('SELECT installation_id FROM protected_pages WHERE project_id=$1 AND id=$2 FOR UPDATE',[data.project,data.page])).rows[0];
    if (!page) throw new TypeError('unknown page');
    const installed=(await client.query("SELECT to_regclass('runtime_aliases') IS NOT NULL AS installed")).rows[0].installed;
    if (!installed) { await client.query('COMMIT'); return {contractVersion:1,state:'NOT_INSTALLED',distribution:null}; }
    let distribution=await readDistribution(client,page.installation_id);
    if (data.action!=='inspect') {
      const origins=distributionOrigins(env);
      // Idempotent explicit publication: a dashboard read never creates aliases.
      if (data.action==='rotate' || !distribution || distributionRoles.some(role=>new URL(distribution!.bases[role]).origin!==origins[role])) {
        const version=(distribution?.version ?? 0)+1;
        const modern=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='runtime_distributions'::regclass AND attname='publication_reason' AND NOT attisdropped) AS ok")).rows[0].ok;
        if(modern) await client.query('INSERT INTO runtime_distributions(installation_id,version,publication_reason) VALUES($1,$2,$3)',[page.installation_id,version,data.action]);
        else {
          if(data.action==='rotate')throw new TypeError('rotation requires migration 053');
          await client.query('INSERT INTO runtime_distributions(installation_id,version) VALUES($1,$2)',[page.installation_id,version]);
        }
        for (const role of distributionRoles) await client.query('INSERT INTO runtime_aliases(alias,installation_id,version,role,origin) VALUES($1,$2,$3,$4,$5)',[randomUUID(),page.installation_id,version,role,origins[role]]);
        distribution=await readDistribution(client,page.installation_id,version);
      }
    }
    const signals=await client.query("SELECT source,last_observed_at FROM page_installation_signals WHERE project_id=$1 AND page_id=$2 AND last_observed_at>=now()-interval '7 days' ORDER BY source",[data.project,data.page]);
    const history=await client.query(`SELECT version,contract_version,created_at,to_jsonb(d)->>'publication_reason' AS reason FROM runtime_distributions d WHERE installation_id=$1 ORDER BY version DESC LIMIT 100`,[page.installation_id]);
    const activityInstalled=(await client.query("SELECT to_regclass('runtime_alias_activity') IS NOT NULL AS installed")).rows[0].installed;
    const aliasActivity=activityInstalled ? (await client.query(`SELECT a.alias,a.version,a.role,s.last_received_at FROM runtime_alias_activity s JOIN runtime_aliases a USING(alias) WHERE a.installation_id=$1 AND s.last_received_at>=now()-interval '7 days' ORDER BY s.last_received_at DESC LIMIT 100`,[page.installation_id])).rows : [];
    await client.query('COMMIT');
    return {contractVersion:1,state:distribution?'PUBLISHED':'NOT_PUBLISHED',distribution,history:history.rows,aliasActivity,snippets:distribution?distributionSnippets(distribution):null,
      diagnostic:{status:'NOT_VERIFIED',confidence:'UNAUTHENTICATED_CLAIM',controlledVerification:{status:'NOT_VERIFIED',reason:'ISOLATED_VERIFIER_UNAVAILABLE'},capabilities:{observation:'UNKNOWN',activeMitigation:'UNKNOWN'},correlation:'ALIAS_ROUTE_AND_DECLARED_CONTEXT_ONLY',signals:signals.rows,layers:['bootstrap','core','fallback','html_canary','css_canary'].map(layer=>({layer,status:signals.rows.some(row=>row.source===layer)?'CLAIM_OBSERVED':'UNKNOWN'}))}};
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
