import type { Pool, PoolClient } from 'pg';
import { assertPageAdministrativeWrite, assertProjectAdministrativeWrite } from './admin-project-write.js';
import { validateAllocation, type Allocation } from './allocation.js';
import { validateOperationalCopy } from './operational-copy-context.js';
import { pageDestination } from './page-redirect.js';
import { listCopyContexts } from './page-copy-contexts.js';
import { PageConflict } from './protected-pages.js';
import { insertPagePolicyVersion } from './protection-admin.js';
import { readDistribution } from './runtime-distribution.js';

export class RedirectRuleConflict extends PageConflict {
  constructor(readonly code: string) { super(code); }
}

type ProjectDestination = { revision: number; destination: string };
type CopyRule = {
  copy_origin: string; copy_pathname: string; revision: number; enabled: boolean;
  default_revision: number | null; url_generation: string; config_generation: string;
  copy_is_official: boolean; version: number; approved_destination: string; allocation: Allocation; stealth: boolean;
};

const latestCopies = `SELECT DISTINCT ON (copy_origin,copy_pathname) * FROM page_redirect_rules
  WHERE project_id=$1 AND page_id=$2 ORDER BY copy_origin,copy_pathname,revision DESC`;

export async function projectDestination(client: Pick<Pool,'query'>, project: string) {
  return (await client.query<ProjectDestination>(`SELECT revision,destination FROM project_redirect_destinations
    WHERE project_id=$1 ORDER BY revision DESC LIMIT 1`, [project])).rows[0] ?? null;
}

export async function redirectRuleSettings(client: PoolClient, project: string, page: string | null) {
  if (!(await client.query("SELECT to_regclass('page_redirect_rules') IS NOT NULL AS ready")).rows[0].ready) return null;
  const projectDefault = await projectDestination(client, project);
  const rules = (await client.query<CopyRule>(`SELECT r.*,v.version,v.approved_destination,v.allocation,v.stealth,
      EXISTS (SELECT 1 FROM protected_page_urls WHERE origin=r.copy_origin)
      OR EXISTS (SELECT 1 FROM projects WHERE origin=r.copy_origin) AS copy_is_official
    FROM (${latestCopies}) r JOIN protection_policy_versions v ON v.project_id=r.project_id AND v.version=r.policy_version
    ORDER BY r.copy_origin,r.copy_pathname`, [project,page])).rows;
  return {projectDefault,rules,contexts:page ? await listCopyContexts(client,project,page) : null};
}

export async function saveRedirectRule(db: Pool, project: string, page: string | null, data: Record<string,unknown>, gatewayOrigin?: string, recheckPool?: (client: PoolClient, origin: string)=>Promise<boolean>) {
  const shapes = {
    'save-default':page ? 'acknowledged,action,destination,page,project,revision' : 'acknowledged,action,destination,project,revision',
    'confirm-copy':'action,allocation,configGeneration,copyOrigin,copyPathname,destination,page,project,revision,urlGeneration',
    'save-copy':'acknowledged,action,configGeneration,copyOrigin,copyPathname,defaultRevision,page,policy,project,revision,urlGeneration',
    'disable-copy':'action,copyOrigin,copyPathname,page,project,revision',
  };
  const action = data.action as keyof typeof shapes;
  if (shapes[action] !== Object.keys(data).sort().join(',') || !Number.isSafeInteger(data.revision)) throw new TypeError('invalid redirect rule');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,project);
    if (page) await assertPageAdministrativeWrite(client,project,page);
    const settings = await redirectRuleSettings(client,project,page);
    if (!settings) throw new RedirectRuleConflict('REDIRECT_SCHEMA_REQUIRED');
    const {projectDefault,rules} = settings;
    let revision: number;
    if (action === 'save-default') {
      if (data.acknowledged !== true) throw new TypeError('explicit confirmation required');
      if (data.revision !== (projectDefault?.revision ?? 0)) throw new PageConflict('project destination changed');
      const destination = pageDestination(data.destination);
      const loop = await client.query(`SELECT 1 FROM (
        SELECT DISTINCT ON (page_id,copy_pathname) enabled,default_revision FROM page_redirect_rules
        WHERE project_id=$1 AND copy_origin=$2 ORDER BY page_id,copy_pathname,revision DESC
      ) r WHERE r.enabled AND r.default_revision IS NOT NULL LIMIT 1`,[project,new URL(destination).origin]);
      if (loop.rowCount) throw new RedirectRuleConflict('PROJECT_DESTINATION_ON_COPY');
      revision = (projectDefault?.revision ?? 0)+1;
      await client.query('INSERT INTO project_redirect_destinations(project_id,revision,destination) VALUES($1,$2,$3)',[project,revision,destination]);
      // Publish the effective URL with its own policy version for each enabled inheriting copy.
      await client.query(`WITH latest AS (
        SELECT DISTINCT ON (page_id,copy_origin,copy_pathname) * FROM page_redirect_rules
        WHERE project_id=$1 ORDER BY page_id,copy_origin,copy_pathname,revision DESC
      ), updates AS (
        SELECT r.*,v.allocation,v.stealth,v.stealth_version,
          (SELECT COALESCE(MAX(version),0) FROM protection_policy_versions WHERE project_id=$1)
            + row_number() OVER (ORDER BY r.page_id,r.copy_origin,r.copy_pathname)::int AS next_version
        FROM latest r JOIN protection_policy_versions v ON v.project_id=r.project_id AND v.version=r.policy_version
        WHERE r.enabled AND r.default_revision IS NOT NULL
      ), published AS (
        INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,allocation,stealth,stealth_version)
        SELECT project_id,next_version,true,$3,allocation,stealth,stealth_version FROM updates
        RETURNING project_id,version
      )
      INSERT INTO page_redirect_rules(project_id,page_id,copy_origin,copy_pathname,revision,url_generation,config_generation,policy_version,default_revision,enabled)
      SELECT r.project_id,r.page_id,r.copy_origin,r.copy_pathname,r.revision+1,r.url_generation,r.config_generation,p.version,$2,true
      FROM updates r JOIN published p ON p.project_id=r.project_id AND p.version=r.next_version`,[project,revision,destination]);
    } else {
      if (!page) throw new TypeError('page scope required');
      const prior = rules.find(rule=>rule.copy_origin===data.copyOrigin && rule.copy_pathname===data.copyPathname);
      if (data.revision !== (prior?.revision ?? 0)) throw new PageConflict('copy rule changed');
      revision = (prior?.revision ?? 0)+1;
      if (action === 'disable-copy') {
        if (!prior?.enabled) throw new PageConflict('no enabled copy rule');
        await appendCopySuspension(client,project,page,prior);
      } else {
        if (action==='confirm-copy' && !settings.contexts) throw new RedirectRuleConflict('REDIRECT_SCHEMA_REQUIRED');
        if (settings.contexts && action==='save-copy') throw new RedirectRuleConflict('COPY_REVIEW_EXPIRED');
        if (!prior && rules.length>=100) throw new PageConflict('copy rule limit');
        const copy = await validateOperationalCopy(client,data.copyOrigin,data.copyPathname,action==='confirm-copy' || data.acknowledged);
        if (!prior && settings.contexts && !settings.contexts.some(context=>context.copy_origin===copy.copy_origin && context.copy_pathname===copy.copy_pathname)) {
          throw new RedirectRuleConflict('COPY_CONTEXT_REQUIRED');
        }
        const scope = (await client.query(`SELECT pp.installation_id,pp.url_generation,pp.config_generation,u.origin
          FROM protected_pages pp JOIN projects p ON p.id=pp.project_id JOIN protected_page_urls u ON u.page_id=pp.id
          WHERE pp.project_id=$1 AND pp.id=$2 AND pp.enabled AND pp.lifecycle_state='ACTIVE' AND p.lifecycle_state='ACTIVE'`,[project,page])).rows;
        if (scope.length!==1) throw new PageConflict('active page with one official URL required');
        const [current] = scope;
        if (data.urlGeneration!==current.url_generation || data.configGeneration!==current.config_generation) {
          throw new PageConflict('page configuration changed');
        }
        const distribution = await readDistribution(client,current.installation_id);
        if (!distribution || new URL(distribution.bases.TELEMETRY).origin!==gatewayOrigin ||
          (recheckPool && !await recheckPool(client,gatewayOrigin))) throw new RedirectRuleConflict('REDIRECT_RUNTIME_REQUIRED');
        const policy = action==='confirm-copy' ? {destination:data.destination,allocation:data.allocation,stealth:false} :
          data.policy as Record<string,unknown> | undefined;
        if (!policy || Object.keys(policy).sort().join(',')!=='allocation,destination,stealth' || typeof policy.stealth!=='boolean') throw new TypeError('invalid copy policy');
        const inherited = policy.destination === null;
        if (inherited && (action==='confirm-copy' || !projectDefault || data.defaultRevision!==projectDefault.revision)) throw new PageConflict('project destination changed');
        if (!inherited && action==='save-copy' && data.defaultRevision!==null) throw new TypeError('unexpected default revision');
        const destination = pageDestination(inherited ? projectDefault?.destination : policy.destination);
        if (new URL(destination).origin===copy.copy_origin) throw new TypeError('destination shares the copy origin');
        let allocation: Allocation;
        try { allocation = validateAllocation(policy.allocation); }
        catch { throw new TypeError('invalid redirect allocation'); }
        if (!Object.values(allocation).some(percent=>percent>0)) throw new TypeError('redirect allocation is zero');
        const version = await insertPagePolicyVersion(client,project,current.origin,{enabled:true,approved_destination:destination,
          allocation,stealth:policy.stealth,stealth_version:2});
        await client.query(`INSERT INTO page_redirect_rules(project_id,page_id,copy_origin,copy_pathname,revision,url_generation,config_generation,policy_version,default_revision,enabled)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`, [project,page,copy.copy_origin,copy.copy_pathname,revision,
          current.url_generation,current.config_generation,version,inherited ? projectDefault?.revision : null]);
      }
    }
    await client.query('COMMIT');
    return {revision};
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function appendCopySuspension(client: PoolClient, project: string, page: string,
  prior: Omit<CopyRule,'approved_destination'|'allocation'|'stealth'|'copy_is_official'>) {
  await client.query(`INSERT INTO page_redirect_rules(project_id,page_id,copy_origin,copy_pathname,revision,url_generation,config_generation,policy_version,default_revision,enabled)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`, [project,page,prior.copy_origin,prior.copy_pathname,prior.revision+1,
    prior.url_generation,prior.config_generation,prior.version,prior.default_revision]);
}

// The existing operational suspension also applies to the same exact copy.
export async function suspendCopyRedirectRule(client: PoolClient, project: string, page: string, origin: string, pathname: string) {
  if (!(await client.query("SELECT to_regclass('page_redirect_rules') IS NOT NULL AS ready")).rows[0].ready) return;
  const prior = (await client.query(`SELECT *,policy_version AS version FROM page_redirect_rules
    WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4 ORDER BY revision DESC LIMIT 1`,
  [project,page,origin,pathname])).rows[0];
  if (prior?.enabled) await appendCopySuspension(client,project,page,prior);
}

type CopyAdmission = {
  project: string; page: string; original: string;
  admitted: boolean; eligibility: string; version: number; approved_destination: string; allocation: Allocation; stealth: boolean; stealth_version: number;
};

// One database snapshot checks the exact approval, its generations and the current project default.
export async function copyRedirectAdmission(db: Pool, installation: string, origin: string, pathname: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(installation)) return null;
  try {
    const result = await db.query<CopyAdmission>(`SELECT p.id AS project,pp.id AS page,official.origin AS original,
      r.enabled AND pp.enabled AND pp.url_generation=r.url_generation AND pp.config_generation=r.config_generation
      AND p.deleted_at IS NULL AND pp.deleted_at IS NULL AND p.lifecycle_state='ACTIVE' AND pp.lifecycle_state='ACTIVE'
      AND official.n=1 AND NOT EXISTS (SELECT 1 FROM protected_page_urls WHERE origin=$2)
      AND NOT EXISTS (SELECT 1 FROM projects WHERE origin=$2) AND v.enabled
      AND (r.default_revision IS NULL OR d.destination=v.approved_destination) AS admitted,
      CASE WHEN NOT r.enabled THEN 'RULE_DISABLED'
        WHEN NOT pp.enabled OR p.deleted_at IS NOT NULL OR pp.deleted_at IS NOT NULL OR p.lifecycle_state<>'ACTIVE' OR pp.lifecycle_state<>'ACTIVE' THEN 'PAGE_INACTIVE'
        WHEN pp.url_generation<>r.url_generation OR pp.config_generation<>r.config_generation OR official.n<>1 THEN 'REVIEW_REQUIRED'
        WHEN EXISTS (SELECT 1 FROM protected_page_urls WHERE origin=$2) OR EXISTS (SELECT 1 FROM projects WHERE origin=$2) THEN 'CONTEXT_EXCLUDED'
        ELSE 'INVALID_POLICY' END AS eligibility,
      v.version, v.allocation, v.stealth, v.stealth_version, v.approved_destination
      FROM protected_pages pp JOIN projects p ON p.id=pp.project_id
      JOIN LATERAL (SELECT * FROM page_redirect_rules WHERE project_id=p.id AND page_id=pp.id
        AND copy_origin=$2 AND copy_pathname=$3 ORDER BY revision DESC LIMIT 1) r ON true
      JOIN protection_policy_versions v ON v.project_id=p.id AND v.version=r.policy_version
      CROSS JOIN LATERAL (SELECT min(origin) AS origin,count(*) AS n FROM protected_page_urls WHERE page_id=pp.id) official
      LEFT JOIN project_redirect_destinations d ON d.project_id=p.id AND d.revision=r.default_revision
      WHERE pp.installation_id=$1`,[installation,origin,pathname]);
    return result.rows[0] ?? null;
  } catch (error) {
    // Existing deployments can continue using legacy approvals while migration 070 is staged.
    if ((error as {code?:string}).code==='42P01') return null;
    throw error;
  }
}
