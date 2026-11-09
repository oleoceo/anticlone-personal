import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { approvalConfiguration } from './page-policy-approval.js';

export class PageConflict extends Error {}

function address(value: unknown) {
  if (typeof value !== 'string' || value.length>2048 || /[\u0000-\u0020\\]/.test(value)) throw new TypeError('invalid URL');
  let url: URL;
  try { url=new URL(value); } catch { throw new TypeError('invalid URL'); }
  if (url.username || url.password || url.search || url.hash || url.hostname.endsWith('.') || url.pathname.includes('%') || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new TypeError('invalid URL');
  return {origin:url.origin,pathname:url.pathname};
}

export async function managePages(db: Pool, body: unknown) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new TypeError('invalid request');
  const data=body as Record<string,unknown>;
  if (typeof data.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) || typeof data.action!=='string') throw new TypeError('invalid request');
  const project=data.project, action=data.action;
  if (action==='approve' && Object.keys(data).sort().join(',')==='action,configGeneration,ctaVersions,entryVersion,generation,page,project' && typeof data.page==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page) && typeof data.generation==='string' && /^(0|[1-9][0-9]{0,18})$/.test(data.generation) && BigInt(data.generation)<=9223372036854775807n && typeof data.configGeneration==='string' && /^(0|[1-9][0-9]{0,18})$/.test(data.configGeneration) && BigInt(data.configGeneration)<=9223372036854775807n && (data.entryVersion===null || (Number.isSafeInteger(data.entryVersion) && (data.entryVersion as number)>0)) && Array.isArray(data.ctaVersions) && data.ctaVersions.length<=100 && data.ctaVersions.every(v=>Number.isSafeInteger(v) && v>0) && new Set(data.ctaVersions).size===data.ctaVersions.length && (data.entryVersion!==null || data.ctaVersions.length>0)) {
    const client=await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('LOCK TABLE projects, protected_pages, protected_page_urls, active_protection_policies, active_cta_surface_policies, page_entry_policy_bindings, page_cta_policy_bindings, cta_points, cta_mappings, cta_destinations, cta_commercial_references IN SHARE ROW EXCLUSIVE MODE');
      const page=await client.query('SELECT url_generation,config_generation,enabled FROM protected_pages WHERE id=$1 AND project_id=$2',[data.page,project]);
      if (!page.rowCount || !page.rows[0].enabled || page.rows[0].url_generation!==data.generation || page.rows[0].config_generation!==data.configGeneration) throw new PageConflict();
      let configuration;
      try { configuration=await approvalConfiguration(client,project,data.page,data.entryVersion as number|null,data.ctaVersions as number[]); } catch { throw new PageConflict(); }
      await client.query('DELETE FROM page_entry_policy_bindings WHERE project_id=$1 AND page_id=$2',[project,data.page]);
      await client.query('DELETE FROM page_cta_policy_bindings WHERE project_id=$1 AND page_id=$2',[project,data.page]);
      if (data.entryVersion!==null) {
        await client.query('INSERT INTO page_entry_policy_bindings(project_id,page_id,version) VALUES($1,$2,$3)',[project,data.page,data.entryVersion]);
      }
      for (const policy of configuration.ctas) {
        await client.query('INSERT INTO page_cta_policy_bindings(project_id,page_id,surface,version) VALUES($1,$2,$3,$4)',[project,data.page,policy.surface,policy.version]);
      }
      const approval=await client.query('INSERT INTO page_policy_approvals(project_id,page_id,url_generation,config_generation,configuration) SELECT project_id,id,url_generation,config_generation,$3 FROM protected_pages WHERE id=$1 AND project_id=$2 RETURNING id',[data.page,project,JSON.stringify(configuration)]);
      const id=approval.rows[0].id;
      if (data.entryVersion!==null) await client.query('INSERT INTO page_policy_approval_entries(approval_id,project_id,version) VALUES($1,$2,$3)',[id,project,data.entryVersion]);
      for (const policy of configuration.ctas) {
        await client.query('INSERT INTO page_policy_approval_ctas(approval_id,project_id,surface,version) VALUES($1,$2,$3,$4)',[id,project,policy.surface,policy.version]);
      }
      await client.query('UPDATE protected_pages SET url_review_required=false WHERE id=$1 AND project_id=$2',[data.page,project]);
      await client.query('COMMIT'); return {page:data.page,generation:data.generation,approval:id,reviewRequired:false};
    } catch(error) { await client.query('ROLLBACK'); if (['23505','40001','40P01'].includes((error as {code?:string}).code ?? '')) throw new PageConflict(); throw error; } finally { client.release(); }
  }
  if (action==='inspect' && Object.keys(data).sort().join(',')==='action,page,project' && typeof data.page==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page)) {
    const client=await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const page=await client.query('SELECT id,project_id,installation_id,name,enabled,url_generation,config_generation,url_review_required FROM protected_pages WHERE id=$1 AND project_id=$2',[data.page,project]);
      if (!page.rowCount) throw new TypeError('unknown page');
      const urls=await client.query('SELECT origin,pathname FROM protected_page_urls WHERE page_id=$1 ORDER BY origin,pathname',[data.page]);
      const entries=await client.query(`SELECT v.version,v.enabled,v.approved_destination,v.stealth,v.allocation,(a.version=v.version) AS active,(b.version=v.version) AS bound
        FROM protection_policy_versions v LEFT JOIN active_protection_policies a ON a.project_id=v.project_id
        LEFT JOIN page_entry_policy_bindings b ON b.project_id=v.project_id AND b.page_id=$2 WHERE v.project_id=$1 ORDER BY v.version DESC LIMIT 100`,[project,data.page]);
      const ctas=await client.query(`SELECT v.version,v.surface,v.pathname,v.enabled,v.allocation,(a.version=v.version) AS active,(b.page_id=$2 AND b.version=v.version) AS bound,b.page_id AS bound_page
        FROM cta_policy_versions v LEFT JOIN active_cta_surface_policies a ON a.project_id=v.project_id AND a.surface=v.surface
        LEFT JOIN page_cta_policy_bindings b ON b.project_id=v.project_id AND b.surface=v.surface WHERE v.project_id=$1 ORDER BY v.version DESC LIMIT 100`,[project,data.page]);
      const points=await client.query(`SELECT p.id,p.surface,p.marker,p.kind,p.offer,p.review_required,m.destination_id,d.url,r.amount,r.currency,r.version AS commercial_version,r.suspension
        FROM cta_points p LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id
        LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id
        LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 ORDER BY p.surface,p.id LIMIT 1000`,[project]);
      await client.query('COMMIT');
      return {page:page.rows[0],urls:urls.rows,entryPolicies:entries.rows,ctaPolicies:ctas.rows,points:points.rows,installationStatus:'NOT_VERIFIED',reviewAvailable:true};
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (action==='list' && Object.keys(data).sort().join(',')==='action,project') {
    const rows=await db.query(`SELECT p.id,p.project_id,p.installation_id,p.name,p.enabled,p.url_review_required,
      COALESCE(json_agg(json_build_object('origin',u.origin,'pathname',u.pathname) ORDER BY u.origin,u.pathname) FILTER (WHERE u.page_id IS NOT NULL),'[]'::json) AS urls
      FROM protected_pages p LEFT JOIN protected_page_urls u ON u.page_id=p.id WHERE p.project_id=$1 GROUP BY p.id ORDER BY p.name,p.id`,[project]);
    return {pages:rows.rows,installationStatus:'NOT_VERIFIED',message:'Inclua o mesmo script na nova página; sinais não comprovam instalação.'};
  }
  if (action==='create' && Object.keys(data).sort().join(',')==='action,name,project,url' && typeof data.name==='string' && data.name.trim() && data.name.length<=100) {
    const url=address(data.url), page=randomUUID(), installation=randomUUID(), client=await db.connect();
    try {
      await client.query('BEGIN');
      const p=await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
      if (!p.rowCount) throw new TypeError('unknown project');
      await client.query('INSERT INTO protected_pages(id,project_id,installation_id,name,url_review_required) VALUES($1,$2,$3,$4,true)',[page,project,installation,data.name.trim()]);
      await client.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[page,url.origin,url.pathname]);
      await client.query('COMMIT'); return {page,installation};
    } catch(error) { await client.query('ROLLBACK'); if ((error as {code?:string}).code==='23505') throw new PageConflict(); throw error; } finally { client.release(); }
  }
  if ((action==='add-url' || action==='remove-url') && Object.keys(data).sort().join(',')==='action,page,project,url' && typeof data.page==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page)) {
    const url=address(data.url), client=await db.connect();
    try {
      await client.query('BEGIN');
      const page=await client.query('SELECT id FROM protected_pages WHERE id=$1 AND project_id=$2 FOR UPDATE',[data.page,project]);
      if (!page.rowCount) throw new TypeError('unknown page');
      if (action==='add-url') await client.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[data.page,url.origin,url.pathname]);
      else {
        const count=await client.query('SELECT count(*)::int n FROM protected_page_urls WHERE page_id=$1',[data.page]);
        if (count.rows[0].n<=1) throw new PageConflict();
        const removed=await client.query('DELETE FROM protected_page_urls WHERE page_id=$1 AND origin=$2 AND pathname=$3',[data.page,url.origin,url.pathname]);
        if (!removed.rowCount) throw new TypeError('unknown URL');
      }
      await client.query('UPDATE protected_pages SET url_review_required=true WHERE id=$1',[data.page]);
      await client.query('COMMIT'); return {page:data.page,reviewRequired:true};
    } catch(error) { await client.query('ROLLBACK'); if ((error as {code?:string}).code==='23505') throw new PageConflict(); throw error; } finally { client.release(); }
  }
  throw new TypeError('invalid request');
}
