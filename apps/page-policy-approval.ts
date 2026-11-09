import type { PoolClient } from 'pg';
import { approvedDestination } from './page-redirect.js';
import { validateAllocation } from './allocation.js';

// A conservative snapshot: changes to any selected surface suspend the approval.
export async function approvalConfiguration(client: PoolClient, project: string, page: string, entry: number|null, versions: number[]) {
  const urls=await client.query('SELECT origin,pathname FROM protected_page_urls WHERE page_id=$1 ORDER BY origin,pathname',[page]);
  if (urls.rowCount!==1) throw new Error('ambiguous page URLs');
  const original=urls.rows[0];
  const entries=entry===null ? {rows:[]} : await client.query(`SELECT v.version,v.enabled,v.stealth,v.approved_destination,v.allocation FROM protection_policy_versions v JOIN active_protection_policies a ON a.project_id=v.project_id AND a.version=v.version WHERE v.project_id=$1 AND v.version=$2`,[project,entry]);
  if (entry!==null && (entries.rows.length!==1 || !entries.rows[0].enabled || !entries.rows[0].stealth)) throw new Error('inactive page policy');
  for (const row of entries.rows) { approvedDestination(row.approved_destination,original.origin); validateAllocation(row.allocation); }
  const policies=await client.query(`SELECT v.version,v.enabled,v.surface,v.pathname,v.allocation,b.page_id AS bound_page FROM cta_policy_versions v JOIN active_cta_surface_policies a ON a.project_id=v.project_id AND a.surface=v.surface AND a.version=v.version LEFT JOIN page_cta_policy_bindings b ON b.project_id=v.project_id AND b.surface=v.surface WHERE v.project_id=$1 AND v.version=ANY($2::int[]) ORDER BY v.surface`,[project,versions]);
  if (policies.rows.length!==versions.length || new Set(policies.rows.map(row=>row.surface)).size!==versions.length) throw new Error('inactive or ambiguous CTA policies');
  for (const row of policies.rows) {
    if (!row.enabled || row.pathname!==original.pathname || (row.bound_page && row.bound_page!==page)) throw new Error('CTA policy incompatible with page');
    validateAllocation(row.allocation);
  }
  const surfaces=policies.rows.map(row=>row.surface);
  const points=await client.query(`SELECT p.id,p.surface,p.marker,p.kind,p.offer,p.review_required,m.destination_id,d.url,r.destination_id AS commercial_destination,r.offer AS commercial_offer,r.amount,r.currency,r.version AS commercial_version,r.suspension FROM cta_points p LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id AND m.offer=p.offer LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 AND p.surface=ANY($2::text[]) ORDER BY p.surface,p.id`,[project,surfaces]);
  for (const surface of surfaces) {
    const selected=points.rows.filter(row=>row.surface===surface);
    if (!selected.length || selected.length>100 || selected.some(row=>row.kind!=='a' || !row.marker || row.review_required || !row.url || row.suspension || (row.commercial_destination && (row.commercial_destination!==row.destination_id || row.commercial_offer!==row.offer)))) throw new Error('CTA mapping or commercial state incompatible');
    if (new Set(selected.map(row=>row.marker)).size!==selected.length) throw new Error('ambiguous CTA markers');
    for (const row of selected) approvedDestination(row.url,original.origin);
  }
  // Binding is recorded independently; do not let creating it change the snapshot.
  return {urls:urls.rows,entry:entries.rows,ctas:policies.rows.map(({bound_page: _bound, ...row})=>row),points:points.rows};
}
