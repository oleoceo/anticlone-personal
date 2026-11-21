import { request } from 'node:https';
import type { Pool, PoolClient } from 'pg';
import { assertPageAdministrativeWrite, assertProjectAdministrativeWrite } from './admin-project-write.js';
import { validateAllocation } from './allocation.js';
import { isOfficialOrigin, validateOperationalCopy } from './operational-copy-context.js';
import { writeOperationalAuthorization, type AuthorizationRow } from './operational-authorization.js';
import { approvalConfiguration, currentApproval, savePageApproval } from './page-policy-approval.js';
import { pageDestination } from './page-redirect.js';
import { insertPagePolicyVersion } from './protection-admin.js';
import { PageConflict } from './protected-pages.js';
import { RedirectRuleConflict, redirectRuleSettings, saveRedirectRule } from './page-redirect-rules.js';
import { readDistribution } from './runtime-distribution.js';

type Gateway = 'OPERATIONAL' | 'OBSERVATION_ONLY' | 'UNREACHABLE' | 'UNCONFIGURED';
async function probeGateway(origin: string | undefined, requireCopyRules = false): Promise<Gateway> {
  let url: URL;
  try {
    url=new URL(origin ?? '');
    if (url.origin!==origin || url.protocol!=='https:' || url.username || url.password) return 'UNCONFIGURED';
  } catch { return 'UNCONFIGURED'; }
  return new Promise(resolve=>{
    const req=request(new URL('/healthz',url),{agent:false,signal:AbortSignal.timeout(1500)},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',(part:string)=>{
        body+=part;
        if (body.length>1024) req.destroy(new Error('probe budget'));
      });
      res.on('error',()=>resolve('UNREACHABLE'));
      res.on('end',()=>{
        try {
          const health=JSON.parse(body);
          if (res.statusCode!==200 || health.status!=='ready' || (requireCopyRules && res.headers['x-anticlone-redirect-contract']!=='2')) return resolve('UNREACHABLE');
          resolve(health.mode==='OPERATIONAL' && health.action==='SCOPED_AUTHORIZATION_REQUIRED' ? 'OPERATIONAL' :
            ['LAB','PILOT_OBSERVE'].includes(health.mode) && health.action==='OBSERVE_ONLY' ? 'OBSERVATION_ONLY' : 'UNREACHABLE');
        } catch { resolve('UNREACHABLE'); }
      });
    });
    req.on('error',()=>resolve('UNREACHABLE'));
    req.end();
  });
}

async function readScope(client: PoolClient, project: string, page: string, gatewayOrigin: string | undefined) {
  const row=(await client.query(`SELECT pp.installation_id, pp.enabled, pp.url_generation,pp.config_generation,
    pp.url_review_required, pp.lifecycle_state AS page_state,p.lifecycle_state AS project_state
    FROM protected_pages pp JOIN projects p ON p.id=pp.project_id
    WHERE pp.project_id=$1 AND pp.id=$2 AND pp.deleted_at IS NULL AND p.deleted_at IS NULL`,[project,page])).rows[0];
  if (!row) throw new TypeError('unknown page');
  const urls=(await client.query('SELECT origin,pathname FROM protected_page_urls WHERE page_id=$1',[page])).rows;
  const authorization=(await client.query<AuthorizationRow>(
    'SELECT * FROM page_operational_authorizations WHERE project_id=$1 AND page_id=$2',[project,page])).rows[0];
  const entry=(await client.query(`SELECT v.version,v.enabled,v.approved_destination,v.allocation,v.stealth,v.stealth_version
    FROM page_entry_policy_bindings b JOIN protection_policy_versions v USING(project_id,version)
    WHERE b.project_id=$1 AND b.page_id=$2`,[project,page])).rows[0] ?? null;
  const ctaVersions=(await client.query<{version:number}>(
    'SELECT version FROM page_cta_policy_bindings WHERE project_id=$1 AND page_id=$2 ORDER BY surface',[project,page])).rows.map(item=>item.version);
  const approval=await currentApproval(client,project,page);
  const distribution=await readDistribution(client,row.installation_id);
  const readyContext=authorization?.enabled && authorization.approval_id===approval?.id &&
    authorization.url_generation===row.url_generation && authorization.config_generation===row.config_generation;
  const schema=(await client.query("SELECT to_regprocedure('invalidate_page_entry_binding()') IS NOT NULL AS ready")).rows[0];
  const issue=!schema.ready ? 'REDIRECT_SCHEMA_REQUIRED' : !row.enabled || row.page_state!=='ACTIVE' || row.project_state!=='ACTIVE' ? 'LP_INACTIVE' :
    urls.length!==1 ? 'LP_URL_REQUIRED' : !distribution ? 'RUNTIME_NOT_PUBLISHED' :
    gatewayOrigin && new URL(distribution.bases.TELEMETRY).origin!==gatewayOrigin ? 'TELEMETRY_MISMATCH' :
    ctaVersions.length && (!approval || !readyContext || !authorization) ? 'CTA_REVIEW_REQUIRED' : null;
  const entryIssue=!entry?.enabled ? null : entry.stealth_version!==2 ? 'LEGACY_STEALTH' :
    Object.values(entry.allocation).every(percent=>percent===0) ? 'ZERO_ALLOCATION' :
    readyContext && new URL(entry.approved_destination).origin===authorization.copy_origin ? 'DESTINATION_ON_COPY' :
    readyContext && await isOfficialOrigin(client,authorization.copy_origin) ? 'OFFICIAL_COPY_ORIGIN' : null;
  return {row,urls,authorization,entry,ctaVersions,approval,readyContext:Boolean(readyContext),issue,entryIssue};
}

export async function pageRedirectAdmin(db: Pool, input: unknown, env=process.env, checkGateway=probeGateway) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid redirect');
  const data=input as Record<string,unknown>;
  const {project,page,action}=data;
  if (typeof project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(project) ||
      typeof page!=='string' || !/^[a-f0-9-]{36}$/i.test(page)) throw new TypeError('invalid scope');
  const gatewayOrigin=env.ADMIN_OPERATIONAL_GATEWAY_ORIGIN;
  if (action==='save-default' || action==='save-copy' || action==='disable-copy') {
    if (action==='save-copy' && await checkGateway(gatewayOrigin,true)!=='OPERATIONAL') throw new RedirectRuleConflict('REDIRECT_GATEWAY_UNAVAILABLE');
    return saveRedirectRule(db,project,page,data,gatewayOrigin);
  }
  const versionFields='action,approvalId,configGeneration,page,project,revision,urlGeneration';
  const expected={inspect:'action,page,project',activate:'acknowledged,action,approvalId,configGeneration,copyOrigin,copyPathname,page,policy,project,revision,urlGeneration',deactivate:versionFields};
  if (typeof action!=='string' || !Object.hasOwn(expected,action) ||
      expected[action as keyof typeof expected]!==Object.keys(data).sort().join(',')) throw new TypeError('invalid action');
  const [gateway,rulesGateway] = action==='deactivate' ? ['UNCONFIGURED','UNCONFIGURED'] as const : await Promise.all([
    checkGateway(gatewayOrigin),action==='inspect' ? checkGateway(gatewayOrigin,true) : Promise.resolve('UNCONFIGURED' as const),
  ]);
  const client=await db.connect();
  try {
    if (action==='inspect') {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope=await readScope(client,project,page,gatewayOrigin);
      const rules=await redirectRuleSettings(client,project,page);
      await client.query('COMMIT');
      return {gateway,rules,rulesGateway,issue:scope.issue,entryIssue:scope.entryIssue,entry:scope.entry,approvalId:scope.approval?.id ?? null,
        authorization:scope.authorization ?? null,active:gateway==='OPERATIONAL' && !scope.issue && !scope.entryIssue && scope.readyContext && scope.entry?.enabled===true,
        urlGeneration:scope.row.url_generation,configGeneration:scope.row.config_generation};
    }
    if (action==='activate' && gateway!=='OPERATIONAL') throw new PageConflict('public gateway unavailable');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await assertProjectAdministrativeWrite(client,project);
    await client.query(`LOCK TABLE projects,protected_pages,protected_page_urls,active_cta_surface_policies,
      page_entry_policy_bindings,page_cta_policy_bindings,cta_points,cta_mappings,cta_destinations,
      cta_commercial_references IN SHARE ROW EXCLUSIVE MODE`);
    await assertPageAdministrativeWrite(client,project,page);
    const scope=await readScope(client,project,page,gatewayOrigin);
    const revision=scope.authorization?.revision ?? 0;
    if (scope.issue==='REDIRECT_SCHEMA_REQUIRED') throw new PageConflict(scope.issue);
    if (data.revision!==revision || data.approvalId!==(scope.approval?.id ?? null) ||
        data.urlGeneration!==scope.row.url_generation || data.configGeneration!==scope.row.config_generation) {
      throw new PageConflict('redirect changed');
    }

    let entry: number | null=null;
    let copy: Pick<AuthorizationRow,'copy_origin'|'copy_pathname'> | undefined;
    if (action==='activate') {
      if (scope.issue) throw new PageConflict(scope.issue);
      copy=await validateOperationalCopy(client,data.copyOrigin,data.copyPathname,data.acknowledged);
      if (scope.ctaVersions.length && (copy.copy_origin!==scope.authorization?.copy_origin ||
          copy.copy_pathname!==scope.authorization?.copy_pathname)) throw new PageConflict('CTA context would change');
      const {policy}=data;
      if (!policy || typeof policy!=='object' || Array.isArray(policy) ||
          Object.keys(policy).sort().join(',')!=='allocation,destination,stealth') throw new TypeError('invalid redirect');
      const options=policy as Record<string,unknown>;
      const allocation=validateAllocation(options.allocation);
      if (typeof options.destination!=='string' || typeof options.stealth!=='boolean') throw new TypeError('invalid redirect policy');
      if (Object.values(allocation).every(value=>value===0)) throw new TypeError('redirect allocation is zero');
      const destination=pageDestination(options.destination);
      if (new URL(destination).origin===copy.copy_origin) throw new TypeError('redirect destination shares the copy origin');
      entry=await insertPagePolicyVersion(client,project,scope.urls[0].origin,{
        enabled:true,approved_destination:destination,allocation,stealth:options.stealth,stealth_version:2,
      });
    } else {
      if (!scope.entry) throw new PageConflict('no bound redirect');
      if (scope.ctaVersions.length && scope.readyContext && scope.authorization &&
          !await isOfficialOrigin(client,scope.authorization.copy_origin)) copy=scope.authorization;
    }

    const ctas=scope.ctaVersions;
    const configuration=action==='activate' || copy ? await approvalConfiguration(client,project,page,entry,ctas,true) : null;
    if (entry===null) {
      await client.query('DELETE FROM page_entry_policy_bindings WHERE project_id=$1 AND page_id=$2',[project,page]);
    } else {
      await client.query(`INSERT INTO page_entry_policy_bindings(project_id,page_id,version) VALUES($1,$2,$3)
        ON CONFLICT(project_id,page_id) DO UPDATE SET version=EXCLUDED.version`,[project,page,entry]);
    }
    if (configuration && copy) {
      const approval=await savePageApproval(client,project,page,entry,configuration);
      await writeOperationalAuthorization(client,project,page,{...copy,revision:revision+1,enabled:true,
        approval_id:approval.id,url_generation:approval.url_generation,config_generation:approval.config_generation});
    } else if (scope.authorization?.enabled) {
      await writeOperationalAuthorization(client,project,page,{...scope.authorization,revision:revision+1,enabled:false});
    }
    await client.query('COMMIT');
    return {version:entry};
  } catch(error) {
    await client.query('ROLLBACK');
    if (['23505','40001','40P01'].includes((error as {code?:string}).code ?? '')) throw new PageConflict('redirect changed');
    throw error;
  } finally { client.release(); }
}
