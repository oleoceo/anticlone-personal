import { assertCtaStealthCompatibility } from './stealth.js';
﻿import type { PoolClient } from 'pg';
import { approvedDestination } from './page-redirect.js';
import { validateAllocation } from './allocation.js';

// A conservative snapshot: changes to any selected surface suspend the approval.
export async function approvalConfiguration(client: PoolClient, project: string, page: string, entry: number|null, versions: number[], runtime = false) {
  const urls=await client.query('SELECT origin,pathname FROM protected_page_urls WHERE page_id=$1 ORDER BY origin,pathname',[page]);
  if (urls.rowCount!==1) throw new Error('ambiguous page URLs');
  const original=urls.rows[0];
  const entries=entry===null ? {rows:[]} : await client.query(`SELECT v.version,v.enabled,v.stealth,v.approved_destination,v.allocation,to_jsonb(v)->'stealth_version' AS stealth_version FROM protection_policy_versions v WHERE v.project_id=$1 AND v.version=$2`,[project,entry]);
  if (entry!==null && (entries.rows.length!==1 || !entries.rows[0].enabled || (!entries.rows[0].stealth && entries.rows[0].stealth_version!==2))) throw new Error('inactive page policy');
  for (const row of entries.rows) { approvedDestination(row.approved_destination,original.origin); validateAllocation(row.allocation); }
  const policies=await client.query(`SELECT v.version,v.enabled,v.surface,v.pathname,v.allocation,to_jsonb(v)->'stealth' AS stealth,to_jsonb(v)->'stealth_version' AS stealth_version,b.page_id AS bound_page FROM cta_policy_versions v JOIN active_cta_surface_policies a ON a.project_id=v.project_id AND a.surface=v.surface AND a.version=v.version LEFT JOIN page_cta_policy_bindings b ON b.project_id=v.project_id AND b.surface=v.surface WHERE v.project_id=$1 AND v.version=ANY($2::int[]) ORDER BY v.surface`,[project,versions]);
  if (policies.rows.length!==versions.length || new Set(policies.rows.map(row=>row.surface)).size!==versions.length) throw new Error('inactive or ambiguous CTA policies');
  for (const row of policies.rows) {
    if (!row.enabled || row.pathname!==original.pathname || (row.bound_page && row.bound_page!==page)) throw new Error('CTA policy incompatible with page');
    validateAllocation(row.allocation);
  }
  assertCtaStealthCompatibility(policies.rows);
  const surfaces=policies.rows.map(row=>row.surface);
  const points=await client.query(`SELECT p.id,p.surface,p.marker,p.kind,p.offer,p.review_required,m.destination_id,d.url,r.destination_id AS commercial_destination,r.offer AS commercial_offer,r.amount,r.currency,r.version AS commercial_version,r.suspension FROM cta_points p LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id AND m.offer=p.offer LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 AND p.surface=ANY($2::text[]) ORDER BY p.surface,p.id`,[project,surfaces]);
  for (const surface of surfaces) {
    const selected=points.rows.filter(row=>row.surface===surface);
    if (!selected.length || selected.length>100 || selected.some(row=>row.kind!=='a' || !row.marker || (!runtime && row.review_required) || !row.url || (!runtime && row.suspension) || (row.commercial_destination && (row.commercial_destination!==row.destination_id || row.commercial_offer!==row.offer)))) throw new Error('CTA mapping or commercial state incompatible');
    if (new Set(selected.map(row=>row.marker)).size!==selected.length) throw new Error('ambiguous CTA markers');
    for (const row of selected) approvedDestination(row.url,original.origin);
  }
  // Binding is recorded independently; do not let creating it change the snapshot.
  return {urls:urls.rows,entry:entries.rows.map(row=>{const copy={...row};if(copy.stealth_version==null)delete copy.stealth_version;return copy;}),ctas:policies.rows.map(row=>({... (row.stealth_version==null ? {} : {stealth:row.stealth,stealth_version:row.stealth_version}),version:row.version,enabled:row.enabled,surface:row.surface,pathname:row.pathname,allocation:row.allocation})),points:runtime ? points.rows.map(row=>({...row,review_required:false,suspension:null})) : points.rows};
}

export async function currentApproval(client: PoolClient, project: string, page: string) {
  const result=await client.query(`SELECT a.id,a.configuration FROM page_policy_approvals a JOIN protected_pages p ON p.id=a.page_id AND p.project_id=a.project_id AND p.url_generation=a.url_generation AND p.config_generation=a.config_generation WHERE a.project_id=$1 AND a.page_id=$2 AND p.enabled AND NOT p.url_review_required ORDER BY a.id DESC LIMIT 1`,[project,page]);
  if (!result.rowCount) return null;
  const approval=result.rows[0];
  const entry=await client.query('SELECT version FROM page_policy_approval_entries WHERE approval_id=$1 AND project_id=$2',[approval.id,project]);
  const ctas=await client.query('SELECT surface,version FROM page_policy_approval_ctas WHERE approval_id=$1 AND project_id=$2 ORDER BY surface',[approval.id,project]);
  const entryVersion=entry.rows[0]?.version ?? null;
  const bindings=await client.query('SELECT version FROM page_entry_policy_bindings WHERE project_id=$1 AND page_id=$2',[project,page]);
  const ctaBindings=await client.query('SELECT surface,version FROM page_cta_policy_bindings WHERE project_id=$1 AND page_id=$2 ORDER BY surface',[project,page]);
  if ((bindings.rows[0]?.version ?? null)!==entryVersion || JSON.stringify(ctaBindings.rows)!==JSON.stringify(ctas.rows)) return null;
  try {
    const configuration=await approvalConfiguration(client,project,page,entryVersion,ctas.rows.map(row=>row.version),true);
    const equal=await client.query('SELECT $1::jsonb = $2::jsonb AS equal',[JSON.stringify(approval.configuration),JSON.stringify(configuration)]);
    return equal.rows[0].equal ? {entryVersion} : null;
  } catch { return null; }
}
