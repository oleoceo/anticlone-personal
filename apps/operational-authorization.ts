import type {Pool,PoolClient} from 'pg';
import {assertProjectAdministrativeWrite,assertPageAdministrativeWrite} from './admin-project-write.js';
import {PageConflict} from './protected-pages.js';
import {currentApproval} from './page-policy-approval.js';
import {validateOperationalCopy} from './operational-copy-context.js';
import {suspendCopyRedirectRule} from './page-redirect-rules.js';
import {operationallyEligible} from './operational-eligibility.js';

export async function operationalAuthorization(db:PoolClient,project:string,page:string,origin:string,pathname:string) {
  const installed=(await db.query("SELECT to_regclass('page_operational_authorizations') IS NOT NULL AS ok")).rows[0].ok;
  if(!installed)return null;
  // Same project/page locks as lifecycle and administrative writes. Suspension
  // takes effect for admissions after its commit; cached browser TTL is unchanged.
  const row=(await db.query(`SELECT a.* FROM page_operational_authorizations a
    JOIN protected_pages p ON p.id=a.page_id AND p.project_id=a.project_id
    AND p.url_generation=a.url_generation AND p.config_generation=a.config_generation
    WHERE a.project_id=$1 AND a.page_id=$2 AND a.enabled
    AND a.approval_id=(SELECT max(id) FROM page_policy_approvals WHERE project_id=$1 AND page_id=$2)
    FOR SHARE OF a`,[project,page])).rows[0];
  return row && row.copy_origin===origin && row.copy_pathname===pathname ? row : null;
}

export type AuthorizationRow = {
  revision: number; enabled: boolean; approval_id: string; url_generation: string; config_generation: string;
  copy_origin: string; copy_pathname: string;
};

export async function writeOperationalAuthorization(client: PoolClient, project: string, page: string, configuration: AuthorizationRow) {
  const {revision,enabled,approval_id,url_generation,config_generation,copy_origin,copy_pathname}=configuration;
  const values=[project,page,revision,enabled,approval_id,url_generation,config_generation,copy_origin,copy_pathname];
  await client.query(`INSERT INTO page_operational_authorizations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(page_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,approval_id=EXCLUDED.approval_id,
      url_generation=EXCLUDED.url_generation,config_generation=EXCLUDED.config_generation,
      copy_origin=EXCLUDED.copy_origin,copy_pathname=EXCLUDED.copy_pathname`,values);
  await client.query('INSERT INTO page_operational_audit(project_id,page_id,revision,configuration) VALUES($1,$2,$3,$4)',[project,page,revision,JSON.stringify(values)]);
}

export async function operationalAdmin(db:Pool,body:unknown) {
  if(!body||typeof body!=='object'||Array.isArray(body))throw new TypeError('invalid authorization');
  const data=body as Record<string,unknown>;
  const action=data.action;
  if(typeof data.project!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(data.project)||typeof data.page!=='string'||!/^[a-f0-9-]{36}$/i.test(data.page)||!['inspect','authorize','suspend'].includes(String(action)))throw new TypeError('invalid authorization');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,data.project,'SHARE');
    await assertPageAdministrativeWrite(client,data.project,data.page);
    const old=(await client.query('SELECT * FROM page_operational_authorizations WHERE project_id=$1 AND page_id=$2',[data.project,data.page])).rows[0];
    if(action!=='inspect') {
      if(!Number.isSafeInteger(data.revision)||data.revision!==(old?.revision??0))throw new TypeError('stale authorization');
      let configuration=old;
      if(action==='authorize') {
        const copy=await validateOperationalCopy(client,data.copyOrigin,data.copyPathname,data.acknowledgeUntrustedContext);
        if(!await operationallyEligible(client,data.project,data.page,true)||!await currentApproval(client,data.project,data.page))throw new TypeError('approved active page required');
        const page=(await client.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[data.page])).rows[0];
        const urls=await client.query('SELECT origin FROM protected_page_urls WHERE page_id=$1',[data.page]);
        if(urls.rowCount!==1)throw new TypeError('single official URL required');
        const approval=(await client.query('SELECT max(id) AS id FROM page_policy_approvals WHERE project_id=$1 AND page_id=$2',[data.project,data.page])).rows[0];
        if (data.expectedApprovalId !== undefined && data.expectedApprovalId !== approval.id) {
          throw new PageConflict('stale page approval');
        }
        configuration={...page,approval_id:approval.id,...copy};
      }
      if(!configuration)throw new TypeError('no authorization to suspend');
      if (action==='suspend') await suspendCopyRedirectRule(client,data.project,data.page,configuration.copy_origin,configuration.copy_pathname);
      await writeOperationalAuthorization(client,data.project,data.page,
        {...configuration,revision:(old?.revision??0)+1,enabled:action==='authorize'});
    }
    const state=(await client.query('SELECT * FROM page_operational_authorizations WHERE project_id=$1 AND page_id=$2',[data.project,data.page])).rows[0]??null;
    await client.query('COMMIT');return {state};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
