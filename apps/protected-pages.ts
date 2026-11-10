import { assertPageAdministrativeWrite } from './admin-project-write.js';
import { deletePage } from './page-deletion.js';
import { isLifecycleAction, projectLifecycle } from './project-lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { approvalConfiguration } from './page-policy-approval.js';

export class PageConflict extends Error {}

async function assertMutableProject(client:PoolClient, project:string) {
  const row=(await client.query("SELECT to_jsonb(p)->>'deleted_at' AS deleted_at FROM projects p WHERE id=$1 FOR UPDATE",[project])).rows[0];
  if (!row) throw new TypeError('unknown project');
  if (row.deleted_at) throw new PageConflict('logically deleted project');
}

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
  if (action==='preview-delete-page' || action==='delete-page') return deletePage(db,data);
  if (isLifecycleAction(action)) return projectLifecycle(db,data);
  if (['project-state','pause-project','resume-project','pause-page','resume-page'].includes(action)) {
    const pageAction=action.endsWith('-page');
    if (Object.keys(data).sort().join(',') !== (pageAction ? 'action,page,project' : 'action,project') || (pageAction && (typeof data.page!=='string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page)))) throw new TypeError('invalid request');
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const p=await client.query("SELECT lifecycle_state,to_jsonb(p)->>'deleted_at' AS deleted_at FROM projects p WHERE id=$1 FOR UPDATE",[project]);
      if (!p.rowCount) throw new TypeError('unknown project');
      if (action==='project-state') {
        const pages=await client.query('SELECT id,installation_id,name,enabled,lifecycle_state FROM protected_pages WHERE project_id=$1 ORDER BY name,id',[project]);
        await client.query('COMMIT'); return {project,state:p.rows[0].lifecycle_state,pages:pages.rows};
      }
      if (pageAction) {
        if (p.rows[0].deleted_at) throw new PageConflict('logically deleted project');
        await assertPageAdministrativeWrite(client,project,data.page as string);
        const page=await client.query('SELECT lifecycle_state,enabled FROM protected_pages WHERE project_id=$1 AND id=$2 FOR UPDATE',[project,data.page]);
        if (!page.rowCount) throw new TypeError('unknown page');
        const next=action==='pause-page' ? 'PAUSED' : 'ACTIVE';
        if (page.rows[0].lifecycle_state===next || (next==='ACTIVE' && !page.rows[0].enabled) || p.rows[0].lifecycle_state==='ARCHIVED') throw new PageConflict();
        await client.query('UPDATE protected_pages SET lifecycle_state=$3 WHERE project_id=$1 AND id=$2',[project,data.page,next]);
        await client.query('COMMIT'); return {project,page:data.page,state:next,installationStatus:'NOT_VERIFIED'};
      }
      const next=action==='pause-project' ? 'PAUSED' : 'ACTIVE';
      if (p.rows[0].lifecycle_state!==(next==='ACTIVE' ? 'PAUSED' : 'ACTIVE')) throw new PageConflict();
      await client.query('UPDATE projects SET lifecycle_state=$2 WHERE id=$1',[project,next]);
      await client.query('COMMIT'); return {project,state:next,installationStatus:'NOT_VERIFIED'};
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (action==='approve' && Object.keys(data).sort().join(',')==='action,configGeneration,ctaVersions,entryVersion,generation,page,project' && typeof data.page==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page) && typeof data.generation==='string' && /^(0|[1-9][0-9]{0,18})$/.test(data.generation) && BigInt(data.generation)<=9223372036854775807n && typeof data.configGeneration==='string' && /^(0|[1-9][0-9]{0,18})$/.test(data.configGeneration) && BigInt(data.configGeneration)<=9223372036854775807n && (data.entryVersion===null || (Number.isSafeInteger(data.entryVersion) && (data.entryVersion as number)>0)) && Array.isArray(data.ctaVersions) && data.ctaVersions.length<=100 && data.ctaVersions.every(v=>Number.isSafeInteger(v) && v>0) && new Set(data.ctaVersions).size===data.ctaVersions.length && (data.entryVersion!==null || data.ctaVersions.length>0)) {
    const client=await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await assertMutableProject(client,project);
      await client.query('LOCK TABLE projects, protected_pages, protected_page_urls, active_protection_policies, active_cta_surface_policies, page_entry_policy_bindings, page_cta_policy_bindings, cta_points, cta_mappings, cta_destinations, cta_commercial_references IN SHARE ROW EXCLUSIVE MODE');
      const page=await client.query('SELECT url_generation,config_generation,enabled FROM protected_pages WHERE id=$1 AND project_id=$2',[data.page,project]);
      if (!page.rowCount || !page.rows[0].enabled || page.rows[0].url_generation!==data.generation || page.rows[0].config_generation!==data.configGeneration) throw new PageConflict();
      await assertPageAdministrativeWrite(client,project,data.page as string);
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
      const entries=await client.query(`SELECT v.version,v.enabled,v.approved_destination,v.stealth,v.allocation,to_jsonb(v)->'stealth_version' AS stealth_version,true AS available,(b.version=v.version) AS active,(b.version=v.version) AS bound
        FROM protection_policy_versions v LEFT JOIN active_protection_policies a ON a.project_id=v.project_id
        LEFT JOIN page_entry_policy_bindings b ON b.project_id=v.project_id AND b.page_id=$2 WHERE v.project_id=$1 ORDER BY v.version DESC LIMIT 100`,[project,data.page]);
      const ctas=await client.query(`SELECT v.version,v.surface,v.pathname,v.enabled,v.allocation,(a.version=v.version) AS active,(b.page_id=$2 AND b.version=v.version) AS bound,b.page_id AS bound_page
        FROM cta_policy_versions v LEFT JOIN active_cta_surface_policies a ON a.project_id=v.project_id AND a.surface=v.surface
        LEFT JOIN page_cta_policy_bindings b ON b.project_id=v.project_id AND b.surface=v.surface WHERE v.project_id=$1 ORDER BY v.version DESC LIMIT 100`,[project,data.page]);
      const points=await client.query(`SELECT p.id,p.surface,p.marker,p.kind,p.offer,p.review_required,m.destination_id,d.url,r.amount,r.currency,r.version AS commercial_version,r.suspension
        FROM cta_points p LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id
        LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id
        LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 ORDER BY p.surface,p.id LIMIT 1000`,[project]);
      const installed=await client.query("SELECT to_regclass('page_installation_signals') IS NOT NULL AS installed");
      const signals=installed.rows[0].installed ? await client.query("SELECT source,last_observed_at FROM page_installation_signals WHERE project_id=$1 AND page_id=$2 AND last_observed_at>=now()-interval '7 days' ORDER BY source",[project,data.page]) : {rows:[]};
      await client.query('COMMIT');
      return {signals:signals.rows,signalConfidence:'UNAUTHENTICATED_CLAIM',page:page.rows[0],urls:urls.rows,entryPolicies:entries.rows,ctaPolicies:ctas.rows,points:points.rows,installationStatus:'NOT_VERIFIED',reviewAvailable:true};
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
      await assertMutableProject(client,project);
      await client.query('INSERT INTO protected_pages(id,project_id,installation_id,name,url_review_required) VALUES($1,$2,$3,$4,true)',[page,project,installation,data.name.trim()]);
      await client.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[page,url.origin,url.pathname]);
      await client.query('COMMIT'); return {page,installation};
    } catch(error) { await client.query('ROLLBACK'); if ((error as {code?:string}).code==='23505') throw new PageConflict(); throw error; } finally { client.release(); }
  }
  if ((action==='add-url' || action==='remove-url') && Object.keys(data).sort().join(',')==='action,page,project,url' && typeof data.page==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.page)) {
    const url=address(data.url), client=await db.connect();
    try {
      await client.query('BEGIN');
      await assertMutableProject(client,project);
      await assertPageAdministrativeWrite(client,project,data.page as string);
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
