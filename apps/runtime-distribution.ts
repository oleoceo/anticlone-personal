import {listTelemetryOrigins, telemetryOriginForPublication} from './telemetry-origins.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assertProjectAdministrativeWrite, assertPageAdministrativeWrite } from './admin-project-write.js';
import {runControlledCheck,verificationPolicy,validVerifierImage,type VerificationSpec,type ControlledCheck} from './installation-verifier.js';

export const distributionRoles = ['SCRIPT','TELEMETRY','STATIC_ASSETS'] as const;
type Role = typeof distributionRoles[number];
export type Distribution = {installation:string; version:number; bases:Record<Role,string>;paths?:Record<string,string>};
export const neutralPaths:Record<string,string>={'runtime.js':'a.js','core.js':'b.js','fallback.js':'c.js','observe':'e','observe/fallback':'f','entry-decision':'g','cta-refresh':'h','observed-session':'j','observed-action':'k','html.gif':'m.gif','css.gif':'n.gif','cta-inventory.js':'p.js'};
type AliasRow = {alias:string;installation_id:string;version:number;role:Role;origin:string;contract_version:number};

export class DistributionBlocked extends TypeError {
  constructor(readonly code: string) { super(code); }
}

function runtimeOriginIssue(value: string | undefined, env: NodeJS.ProcessEnv) {
  if (!value) return 'RUNTIME_ORIGIN_MISSING';
  try {
    if (value.length>2048 || /[\s\\<>"']/.test(value)) throw new TypeError();
    const url = new URL(value);
    if (url.origin!==value || url.username || url.password || url.hostname.endsWith('.') ||
      (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new TypeError();
    if (env.ADMIN_PUBLIC_ORIGIN && new URL(env.ADMIN_PUBLIC_ORIGIN).hostname===url.hostname) return 'RUNTIME_ADMIN_HOST_CONFLICT';
  } catch { return 'RUNTIME_ORIGIN_INVALID'; }
}

// Configuration is private and operator-owned; never infer origins from a request.
function configuredOrigins(env: NodeJS.ProcessEnv) {
  const origins = {} as Record<Role,string>;
  const issues: {code: string; role: Role}[] = [];
  for (const role of distributionRoles) {
    const value = env['RUNTIME_'+role+'_ORIGIN'] ?? env.RUNTIME_PUBLIC_ORIGIN;
    const code = runtimeOriginIssue(value,env);
    if (code) issues.push({code,role});
    else origins[role] = value!;
  }
  return {origins,issues};
}

export function distributionOrigins(env: NodeJS.ProcessEnv): Record<Role,string> {
  const {origins,issues} = configuredOrigins(env);
  if (issues.length) throw new DistributionBlocked(issues[0].code);
  return origins;
}

function verifierConfiguration(env: NodeJS.ProcessEnv) {
  if (!env.INSTALLATION_VERIFIER_IMAGE) return 'ISOLATED_VERIFIER_UNAVAILABLE';
  return validVerifierImage(env.INSTALLATION_VERIFIER_IMAGE) ? null : 'VERIFIER_IMAGE_INVALID';
}

export async function installationPrerequisites(db: Pick<Pool,'query'>, env=process.env) {
  const schema = (await db.query<{distribution: boolean; rotation: boolean; verifier: boolean; activity: boolean}>(`
    SELECT to_regclass('runtime_aliases') IS NOT NULL AND to_regclass('page_installation_signals') IS NOT NULL
      AND to_regclass('runtime_distributions') IS NOT NULL AS distribution,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('runtime_distributions')
        AND attname='publication_reason' AND NOT attisdropped) AS rotation,
      to_regclass('controlled_installation_checks') IS NOT NULL AS verifier,
      to_regclass('runtime_alias_activity') IS NOT NULL AS activity`)).rows[0];
  const {origins,issues} = configuredOrigins(env);
  const publicationIssues: {code: string; role?: Role}[] = schema.distribution
    ? issues : [{code:'DISTRIBUTION_SCHEMA_MISSING'}, ...issues];
  return {origins, schema, publicationIssues,
    verifierIssue: verifierConfiguration(env) ?? (!schema.verifier ? 'VERIFIER_SCHEMA_MISSING' : null)};
}

function verificationIssue(targets: string[], active: boolean, distribution: Distribution|null, prerequisite: string|null) {
  if (!active) return 'INACTIVE_INSTALLATION';
  if (!distribution) return 'INSTALLATION_NOT_PUBLISHED';
  if (targets.length !== 1) return 'SINGLE_OFFICIAL_URL_REQUIRED';
  try { verificationPolicy({target:targets[0],distribution}); }
  catch { return 'VERIFIER_HTTPS_REQUIRED'; }
  return prerequisite;
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
  const explicit = Object.hasOwn(data,'telemetryOrigin');
  if (explicit && (!['publish','rotate'].includes(String(data.action)) || (data.telemetryOrigin !== null &&
    (typeof data.telemetryOrigin !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(data.telemetryOrigin))))) throw new TypeError('invalid telemetry origin');
  if (Object.keys(data).sort().join(',')!==(explicit?'action,page,project,telemetryOrigin':'action,page,project') || typeof data.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) || typeof data.page!=='string' || !/^[a-f0-9-]{36}$/i.test(data.page) || !['inspect','publish','rotate','verify'].includes(String(data.action))) throw new TypeError('invalid distribution');
  if(data.action==='verify'){
    const attempt=await verifyPublishedInstallation(db,data.project,data.page,env);
    const current=await readOrPublish(db,{project:data.project,page:data.page,action:'inspect'},env);
    const latest=current.diagnostic?.controlledVerification;
    const attemptStillCurrent=latest && 'checkedAt' in latest && latest.checkedAt===attempt.checkedAt &&
      current.distribution?.version===attempt.revision;
    const verificationAttempt=attemptStillCurrent || attempt.reason==='CONFIGURATION_CHANGED' ? attempt :
      {...attempt,status:'NOT_VERIFIED',reason:'VERIFICATION_SUPERSEDED'};
    return {...current,verificationAttempt};
  }
  return readOrPublish(db,{project:data.project,page:data.page,action:String(data.action),telemetryOrigin:data.telemetryOrigin as string|null|undefined},env);
}

async function distributionPage(client: PoolClient, project: string, page: string) {
  return (await client.query<{
    installation_id:string; url_generation:string; config_generation:string;
    enabled:boolean; active:boolean; targets:string[];
  }>(`SELECT p.installation_id,to_jsonb(p)->>'url_generation' AS url_generation,
      to_jsonb(p)->>'config_generation' AS config_generation,p.enabled,
      coalesce(to_jsonb(p)->>'lifecycle_state','ACTIVE')='ACTIVE' AND to_jsonb(p)->>'deleted_at' IS NULL
      AND coalesce(to_jsonb(pr)->>'lifecycle_state','ACTIVE')='ACTIVE' AND to_jsonb(pr)->>'deleted_at' IS NULL AS active,
      ARRAY(SELECT u.origin||u.pathname FROM protected_page_urls u WHERE u.page_id=p.id) AS targets
      FROM protected_pages p JOIN projects pr ON pr.id=p.project_id WHERE p.project_id=$1 AND p.id=$2`,
    [project,page])).rows[0];
}

async function readOrPublish(db: Pool, data: {project:string;page:string;action:string;telemetryOrigin?:string|null}, env: NodeJS.ProcessEnv) {
  const client=await db.connect();
  try {
    const inspecting=data.action==='inspect';
    await client.query(inspecting?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    if (!inspecting) {
      await assertProjectAdministrativeWrite(client,data.project,'SHARE');
      await assertPageAdministrativeWrite(client,data.project,data.page);
    }
    const page=await distributionPage(client,data.project,data.page);
    if (!page) throw new TypeError('unknown page');
    const {origins:defaults,schema,publicationIssues,verifierIssue}=await installationPrerequisites(client,env);
    if (!schema.distribution) {
      if (!inspecting) throw new DistributionBlocked(publicationIssues[0].code);
      await client.query('COMMIT');
      return {contractVersion:1,state:'NOT_INSTALLED',distribution:null,
        publication:{ready:false,defaultsReady:false,issues:publicationIssues,rotationAvailable:schema.rotation,changesRequired:false},
        verification:{ready:false,issue:'INSTALLATION_NOT_PUBLISHED'}};
    }
    let distribution=await readDistribution(client,page.installation_id);
    const {items} = await listTelemetryOrigins(client, env);
    const registered = new Map(items.map(item => [item.origin,item.state]));
    const eligible = items.filter(item => item.state === 'OPERATIONAL').map(item => item.origin);
    const previous = distribution ? new URL(distribution.bases.TELEMETRY).origin : undefined;
    const explicit = data.telemetryOrigin !== undefined;
    const selected = explicit ? data.telemetryOrigin : previous && registered.has(previous) ? previous : undefined;
    const persisted = distribution?.bases;
    const origins = {...defaults};
    if (selected) {
      // Existing split-role revisions are kept by implicit publication and rotation.
      for (const role of distributionRoles) origins[role] = explicit ? selected : new URL(persisted![role]).origin;
    }
    const unavailable = {code:'TELEMETRY_ORIGIN_UNAVAILABLE'};
    const blockedDefault = Object.values(defaults).some(origin => registered.has(origin) && registered.get(origin) !== 'OPERATIONAL');
    const defaultsReady = !publicationIssues.length && !blockedDefault;
    const issues = selected ? distributionRoles.flatMap(role => {
      const code = runtimeOriginIssue(origins[role],env);
      return code ? [{code,role}] : [];
    }) : [...publicationIssues];
    const pooled = new Set(Object.values(origins).filter(origin => registered.has(origin)));
    if (selected) pooled.add(selected);
    if ([...pooled].some(origin => registered.get(origin) !== 'OPERATIONAL')) issues.push(unavailable);
    const publication = {ready:!issues.length,defaultsReady,issues,rotationAvailable:schema.rotation,changesRequired:false};
    const changesOrigins = (current: Distribution) => distributionRoles.some(role=>new URL(current.bases[role]).origin!==origins[role]);
    if (!inspecting) {
      if (issues.length) throw new DistributionBlocked(issues[0].code);
      for (const origin of [...pooled].sort()) {
        if (!await telemetryOriginForPublication(client,origin,env)) throw new DistributionBlocked(unavailable.code);
      }
      if (data.action==='rotate' && !schema.rotation) throw new DistributionBlocked('ROTATION_SCHEMA_MISSING');
      // Idempotent explicit publication: a dashboard read never creates aliases.
      if (data.action==='rotate' || !distribution || changesOrigins(distribution)) {
        const version=(distribution?.version ?? 0)+1;
        if(schema.rotation) await client.query('INSERT INTO runtime_distributions(installation_id,version,publication_reason) VALUES($1,$2,$3)',[page.installation_id,version,data.action]);
        else await client.query('INSERT INTO runtime_distributions(installation_id,version) VALUES($1,$2)',[page.installation_id,version]);
        for (const role of distributionRoles) await client.query('INSERT INTO runtime_aliases(alias,installation_id,version,role,origin) VALUES($1,$2,$3,$4,$5)',[randomUUID(),page.installation_id,version,role,origins[role]]);
        distribution=await readDistribution(client,page.installation_id,version);
      }
    }
    publication.changesRequired=!!distribution && publication.ready && changesOrigins(distribution);
    const issue=verificationIssue(page.targets,page.enabled && page.active,distribution,verifierIssue);
    const signals=await client.query("SELECT source,last_observed_at FROM page_installation_signals WHERE project_id=$1 AND page_id=$2 AND last_observed_at>=now()-interval '7 days' ORDER BY source",[data.project,data.page]);
    const history=await client.query(`SELECT version,contract_version,created_at,to_jsonb(d)->>'publication_reason' AS reason FROM runtime_distributions d WHERE installation_id=$1 ORDER BY version DESC LIMIT 100`,[page.installation_id]);
    const aliasActivity=schema.activity ? (await client.query(`SELECT a.alias,a.version,a.role,s.source,s.last_received_at FROM runtime_alias_activity s JOIN runtime_aliases a USING(alias) WHERE a.installation_id=$1 AND s.last_received_at>=now()-interval '7 days' ORDER BY s.last_received_at DESC LIMIT 100`,[page.installation_id])).rows : [];
    const currentRoutes=new Set<string>(schema.activity && distribution ? (await client.query<{source:string}>(`
      SELECT DISTINCT s.source FROM runtime_alias_activity s JOIN runtime_aliases a USING(alias)
      WHERE a.installation_id=$1 AND a.version=$2 AND s.last_received_at>=now()-interval '7 days'`,
    [page.installation_id,distribution.version])).rows.map(row=>row.source) : []);
    const controlled=schema.verifier?(await client.query(`SELECT c.result FROM controlled_installation_checks c JOIN protected_pages p ON p.id=c.page_id JOIN projects pr ON pr.id=p.project_id WHERE c.page_id=$1 AND c.project_id=$2 AND c.distribution_version=$3 AND c.url_generation=p.url_generation AND c.config_generation=p.config_generation AND p.enabled AND p.lifecycle_state='ACTIVE' AND p.deleted_at IS NULL AND pr.lifecycle_state='ACTIVE' AND pr.deleted_at IS NULL AND c.checked_at>now()-interval '7 days' ORDER BY c.checked_at DESC LIMIT 1`,[data.page,data.project,distribution?.version??0])).rows[0]?.result as ControlledCheck|undefined:undefined;
    await client.query('COMMIT');
    const measured=controlled && controlled.status!=='NOT_VERIFIED' ? controlled.layers : undefined;
    return {contractVersion:1,state:distribution?'PUBLISHED':'NOT_PUBLISHED',distribution,publication,telemetryOrigins:eligible,
      telemetryEndpoints:items.map(({origin,state})=>({origin,state})),selectedTelemetryOrigin:selected ?? null,
      verification:{ready:!issue,issue},history:history.rows,aliasActivity,snippets:distribution?distributionSnippets(distribution):null,
      diagnostic:{status:controlled?.status??'NOT_VERIFIED',confidence:measured?'CONTROLLED_CURRENT_LOAD_ONLY':'UNAUTHENTICATED_CLAIM',
        controlledVerification:controlled??{status:'NOT_VERIFIED',reason:issue??'NO_CURRENT_VERIFICATION'},
        capabilities:{observation:'UNKNOWN',activeMitigation:'UNKNOWN'},correlation:'ALIAS_ROUTE_AND_DECLARED_CONTEXT_ONLY',
        signals:signals.rows,layers:['bootstrap','core','fallback','html_canary','css_canary'].map(layer=>({
          layer,
          status:currentRoutes.has(layer)?'ROUTE_OBSERVED':signals.rows.some(row=>row.source===layer)?'CLAIM_OBSERVED':'UNKNOWN',
          controlled: measured?.[layer]===true?'OBSERVED':measured?.[layer]===false?'NOT_OBSERVED':'NOT_TESTED',
        }))}};
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

// No URL is accepted from the request. Snapshot the persisted approved page,
// release database locks for browser/network I/O, then revalidate before storing.
export async function verifyPublishedInstallation(db:Pool,project:string,page:string,env:NodeJS.ProcessEnv=process.env,run:(spec:VerificationSpec,image:string)=>Promise<ControlledCheck>=runControlledCheck){
  const client=await db.connect();
  let snapshot:Awaited<ReturnType<typeof distributionPage>>;
  let distribution:Distribution;
  const image=env.INSTALLATION_VERIFIER_IMAGE;
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,project,'SHARE');
    await assertPageAdministrativeWrite(client,project,page);
    const {schema,verifierIssue}=await installationPrerequisites(client,env);
    snapshot=await distributionPage(client,project,page);
    const published=schema.distribution ? await readDistribution(client,snapshot.installation_id) : null;
    const issue=verificationIssue(snapshot.targets,snapshot.enabled && snapshot.active,published,verifierIssue);
    if(issue)throw new DistributionBlocked(issue);
    distribution=published!;
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const check=await run({target:snapshot.targets[0],distribution},image!);
  const final=await db.connect();
  try{
    await final.query('BEGIN');await assertProjectAdministrativeWrite(final,project,'SHARE');await assertPageAdministrativeWrite(final,project,page);
    const current=(await final.query('SELECT p.url_generation::text,p.config_generation::text,p.enabled,p.deleted_at,p.lifecycle_state,pr.lifecycle_state AS project_state FROM protected_pages p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1',[page])).rows[0];
    const latest=await readDistribution(final,snapshot.installation_id);
    if(current.url_generation!==snapshot.url_generation||current.config_generation!==snapshot.config_generation||!current.enabled||current.deleted_at||current.lifecycle_state!=='ACTIVE'||current.project_state!=='ACTIVE'||latest?.version!==distribution.version){check.status='NOT_VERIFIED';check.reason='CONFIGURATION_CHANGED';}
    await final.query('INSERT INTO controlled_installation_checks(id,project_id,page_id,distribution_version,url_generation,config_generation,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),project,page,distribution.version,snapshot.url_generation,snapshot.config_generation,check]);
    await final.query("DELETE FROM controlled_installation_checks WHERE project_id=$1 AND checked_at<now()-interval '7 days'",[project]);
    await final.query('DELETE FROM controlled_installation_checks WHERE page_id=$1 AND id NOT IN (SELECT id FROM controlled_installation_checks WHERE page_id=$1 ORDER BY checked_at DESC LIMIT 10)',[page]);
    await final.query('COMMIT');return {...check,revision:distribution.version};
  }catch(error){await final.query('ROLLBACK');throw error;}finally{final.release();}
}
