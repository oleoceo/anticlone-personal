import type {Pool,PoolClient} from 'pg';
import {assertProjectAdministrativeWrite,assertPageAdministrativeWrite} from './admin-project-write.js';
import {currentApproval} from './page-policy-approval.js';
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
        if(data.acknowledgeUntrustedContext!==true||typeof data.copyOrigin!=='string'||typeof data.copyPathname!=='string'||!/^\/[a-zA-Z0-9/_-]{0,200}$/.test(data.copyPathname))throw new TypeError('explicit context required');
        const url=new URL(data.copyOrigin);
        if(url.origin!==data.copyOrigin||url.protocol!=='https:'||url.username||url.password)throw new TypeError('HTTPS context required');
        if(!await operationallyEligible(client,data.project,data.page,true)||!await currentApproval(client,data.project,data.page))throw new TypeError('approved active page required');
        const page=(await client.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[data.page])).rows[0];
        const urls=await client.query('SELECT origin FROM protected_page_urls WHERE page_id=$1',[data.page]);
        // Never authorize any original origin, including another LP/project.
        const official=await client.query('SELECT 1 FROM protected_page_urls WHERE origin=$1 UNION ALL SELECT 1 FROM projects WHERE origin=$1',[url.origin]);
        if(urls.rowCount!==1||official.rowCount)throw new TypeError('original context forbidden');
        const approval=(await client.query('SELECT max(id) AS id FROM page_policy_approvals WHERE project_id=$1 AND page_id=$2',[data.project,data.page])).rows[0];
        configuration={...page,approval_id:approval.id,copy_origin:url.origin,copy_pathname:data.copyPathname};
      }
      if(!configuration)throw new TypeError('no authorization to suspend');
      const revision=(old?.revision??0)+1;
      const values=[data.project,data.page,revision,action==='authorize',configuration.approval_id,configuration.url_generation,configuration.config_generation,configuration.copy_origin,configuration.copy_pathname];
      await client.query(`INSERT INTO page_operational_authorizations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(page_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,approval_id=EXCLUDED.approval_id,url_generation=EXCLUDED.url_generation,config_generation=EXCLUDED.config_generation,copy_origin=EXCLUDED.copy_origin,copy_pathname=EXCLUDED.copy_pathname`,values);
      await client.query('INSERT INTO page_operational_audit(project_id,page_id,revision,configuration) VALUES($1,$2,$3,$4)',[data.project,data.page,revision,JSON.stringify(values)]);
    }
    const state=(await client.query('SELECT * FROM page_operational_authorizations WHERE project_id=$1 AND page_id=$2',[data.project,data.page])).rows[0]??null;
    await client.query('COMMIT');return {state};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
