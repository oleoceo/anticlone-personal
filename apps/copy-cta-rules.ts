import type {Pool, PoolClient} from 'pg';
import {assertPageAdministrativeWrite, assertProjectAdministrativeWrite} from './admin-project-write.js';
import {selected, validateAllocation, type Allocation} from './allocation.js';
import {normalizeHttpsAddress} from './https-address.js';
import {validCopyPath} from './page-copy-contexts.js';
import {isOfficialOrigin} from './operational-copy-context.js';
import {PageConflict} from './protected-pages.js';
import {readDistribution} from './runtime-distribution.js';

const markerPattern = /^[a-zA-Z0-9_-]{8,64}$/;
const surfacePattern = /^[a-zA-Z0-9_-]{0,64}$/;
const uniform = (percent:number):Allocation => ({
  DIRECT_UNKNOWN:percent, PAID_ATTRIBUTED:percent, ORGANIC:percent, REFERRAL:percent
});
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Point = {marker:string; surface:string; native_url:string|null; native_digest:string;
  kind?:'link'|'button'|'whatsapp'; evidence?:'marker'|'inline'|'attribute'|'destination'; compatible?:boolean};
const publicPath = /^\/(?:checkout|check-out|comprar|compra|buy|purchase|order|oferta|offer|promo|payment|pagamento)(?:-(?:basico|completo|teste|basic|complete|standard|premium|discount|exit|popup|js|trial)){0,4}(?:\.html)?\/?$/i;
type Rule = Point & {version:number; current:boolean; enabled:boolean; destination:string; percent:number; allocation:Allocation|null; display_name:string|null;discovery_required:boolean; activation_kind:'a'|'button'};
type Scope = {project:string;page:string;origin:string;pathname:string};
export const ctaPointKey = (marker:string,surface:string) => surface+':'+marker;
const scopeParameters = ({project,page,origin,pathname}:Scope) => [project,page,origin,pathname];
const installed = async (db:Pick<Pool,'query'>) =>
  (await db.query("SELECT to_regclass('copy_cta_rules') IS NOT NULL AS ready")).rows[0].ready as boolean;

export function validateCopyCtaInventory(input:unknown): Point[] {
  if (!Array.isArray(input) || input.length>50) throw new TypeError('invalid CTA inventory');
  const unique = new Set<string>();
  return input.map(point=>{
    if (!point || typeof point!=='object') throw new TypeError('invalid CTA');
    const keys=Object.keys(point).sort().join(',');
    const modern=keys==='compatible,evidence,kind,marker,native_digest,native_url,surface';
    if ((!modern && keys!=='marker,native_digest,native_url,surface') ||
        typeof point.marker!=='string' || !markerPattern.test(point.marker) ||
        typeof point.surface!=='string' || !surfacePattern.test(point.surface) ||
        typeof point.native_digest!=='string' || !/^[a-f0-9]{64}$/.test(point.native_digest) ||
        (modern && (!['link','button','whatsapp'].includes(point.kind) ||
          !['marker','inline','attribute','destination'].includes(point.evidence) || typeof point.compatible!=='boolean'))) {
      throw new TypeError('invalid CTA');
    }
    const key=ctaPointKey(point.marker,point.surface);
    if (unique.has(key)) throw new TypeError('duplicate CTA identity');
    unique.add(key);
    let native_url:string|null=null;
    if (point.native_url!==null || !modern || point.compatible) {
      if (typeof point.native_url!=='string' || point.native_url.length>1024 || /[\s\\]/u.test(point.native_url)) {
        throw new TypeError('invalid CTA URL');
      }
      const url=new URL(point.native_url);
      if (!['http:','https:'].includes(url.protocol) || !url.hostname ||
          (url.pathname!=='/' && (!modern || !publicPath.test(url.pathname))) ||
          url.search || url.hash || url.username || url.password) throw new TypeError('invalid CTA URL');
      native_url=url.href;
    }
    return {marker:point.marker,surface:point.surface,native_url,native_digest:point.native_digest,
      ...(modern ? {kind:point.kind,evidence:point.evidence,compatible:point.compatible} : {})};
  });
}

export async function rememberCopyCtas(db:PoolClient, scope:Scope, points:Point[], incremental=false) {
  if (!await installed(db)) return;
  const {project,page,origin,pathname}=scope;
  if (incremental) {
    await db.query(`INSERT INTO copy_cta_inventory(project_id,page_id,copy_origin,copy_pathname,points)
      SELECT project_id,page_id,copy_origin,copy_pathname,COALESCE((
        SELECT jsonb_agg(point || jsonb_build_object('seen_at',statement_timestamp())) FROM jsonb_array_elements($5::jsonb) point
      ), '[]'::jsonb) FROM page_copy_contexts
      WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4
      ON CONFLICT(project_id,page_id,copy_origin,copy_pathname) DO UPDATE SET points=(
        SELECT COALESCE(jsonb_agg(retained.point),'[]'::jsonb) FROM (
          SELECT recent.point FROM (
            SELECT DISTINCT ON (point->>'marker',point->>'surface') point
            FROM (
              SELECT point FROM jsonb_array_elements(EXCLUDED.points) point
              UNION ALL
              SELECT point || jsonb_build_object('seen_at',COALESCE((point->>'seen_at')::timestamptz,copy_cta_inventory.observed_at))
              FROM jsonb_array_elements(copy_cta_inventory.points) point
              WHERE COALESCE((point->>'seen_at')::timestamptz,copy_cta_inventory.observed_at)>=statement_timestamp()-interval '7 days'
            ) candidates ORDER BY point->>'marker',point->>'surface',(point->>'seen_at')::timestamptz DESC
          ) recent ORDER BY (recent.point->>'seen_at')::timestamptz DESC, recent.point->>'marker',recent.point->>'surface'
          LIMIT 50
        ) retained
      ),observed_at=clock_timestamp()`,[project,page,origin,pathname,JSON.stringify(points)]);
    return;
  }
  await db.query(`INSERT INTO copy_cta_inventory(project_id,page_id,copy_origin,copy_pathname,points)
    SELECT project_id,page_id,copy_origin,copy_pathname,$5 FROM page_copy_contexts
    WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4
    ON CONFLICT(project_id,page_id,copy_origin,copy_pathname) DO UPDATE SET points=EXCLUDED.points, observed_at=clock_timestamp()
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(copy_cta_inventory.points) point
      WHERE (point->>'seen_at')::timestamptz>=statement_timestamp()-interval '7 days')
    AND (copy_cta_inventory.points IS DISTINCT FROM EXCLUDED.points OR
      copy_cta_inventory.observed_at<clock_timestamp()-interval '1 minute')`,[project,page,origin,pathname,JSON.stringify(points)]);
}

async function rulesForCopy(db:Pick<Pool,'query'>, scope:Scope) {
  return (await db.query<Rule>(`SELECT DISTINCT ON(r.surface,r.marker) r.*,
    (r.url_generation=p.url_generation AND r.config_generation=p.config_generation) AS current
    FROM copy_cta_rules r JOIN protected_pages p ON p.id=r.page_id AND p.project_id=r.project_id
    WHERE r.project_id=$1 AND r.page_id=$2 AND r.copy_origin=$3 AND r.copy_pathname=$4
    ORDER BY r.surface,r.marker,r.version DESC`,scopeParameters(scope))).rows;
}

async function pointsForCopy(db:Pick<Pool,'query'>, scope:Scope):Promise<Point[]> {
  return (await db.query(`SELECT COALESCE((SELECT jsonb_agg(point - 'seen_at') FROM jsonb_array_elements(points) point
      WHERE COALESCE((point->>'seen_at')::timestamptz,observed_at)>=clock_timestamp()-interval '7 days'),'[]'::jsonb) AS points
    FROM copy_cta_inventory
    WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4 AND observed_at>=clock_timestamp()-interval '7 days'`,
  scopeParameters(scope))).rows[0]?.points ?? [];
}

// Admission priority comes from a current administrative rule, independently
// of the input session, browser claims, or decision allocation.
export async function hasApprovedCopyCta(client: PoolClient, scope: Scope) {
  if (!await installed(client)) return false;
  const {rows:[row]}=await client.query(`
    SELECT EXISTS(
      SELECT 1 FROM (
        SELECT DISTINCT ON (surface,marker) enabled,url_generation,config_generation
        FROM copy_cta_rules
        WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4
        ORDER BY surface,marker,version DESC
      ) r JOIN protected_pages p ON p.project_id=$1 AND p.id=$2
      WHERE r.enabled AND r.url_generation=p.url_generation AND r.config_generation=p.config_generation
    ) AS approved
  `,scopeParameters(scope));
  return row.approved===true;
}

export async function copyCtaDecision(client:PoolClient, scope:Scope, session:unknown, trafficClass:string, discoveryRuntime=false) {
  if (!await installed(client)) return null;
  const rules=await rulesForCopy(client,scope);
  if (!rules.length || await isOfficialOrigin(client,scope.origin)) return null;
  const version=Math.max(...rules.map(rule=>rule.version));
  const conflict=await client.query<{marker:string;surface:string}>(`SELECT p.marker,p.surface FROM cta_points p
    LEFT JOIN cta_commercial_references r ON r.project_id=p.project_id AND r.point_id=p.id
    WHERE p.project_id=$1 AND p.marker=ANY($2::text[])
      AND (p.review_required OR r.point_id IS NOT NULL)`,[scope.project,rules.map(rule=>rule.marker)]);
  const protectedPoints=new Set(conflict.rows.map(point=>ctaPointKey(point.marker,point.surface)));
  const mappings=rules.flatMap(rule=>{
    const {marker,surface,native_digest,percent}=rule;
    if (!rule.enabled || !rule.current || rule.discovery_required && !discoveryRuntime || protectedPoints.has(ctaPointKey(marker,surface)) || !surface && conflict.rows.some(point=>point.marker===marker)) return [];
    const allocation=rule.allocation ?? uniform(percent);
    if (!selected(session,'REPLACE_CONVERSION',rule.version,allocation,trafficClass)) return [];
    return [{marker,surface:surface||undefined,kind:rule.activation_kind ?? 'a',destination:rule.destination,nativeDigest:native_digest,requiresSurface:!!surface,copyRuleVersion:rule.version}];
  });
  return {version,mappings,replaced:new Set(rules.map(rule=>ctaPointKey(rule.marker,rule.surface)))};
}

export async function copyCtaAdmin(db:Pool, input:Record<string,unknown>,gatewayOrigin?:string, recheckPool?: (client: PoolClient, origin: string)=>Promise<boolean>) {
  const {project,page,action,marker,surface,revision}=input;
  if (typeof project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(project) || typeof page!=='string' || !uuid.test(page)) throw new TypeError('invalid scope');
  const copy=new URL(normalizeHttpsAddress(input.copyUrl));
  if (copy.search || copy.hash || !validCopyPath(copy.pathname)) throw new TypeError('invalid copy');
  const scope={project,page,origin:copy.origin,pathname:copy.pathname};
  const keys=Object.keys(input).sort().join(',');
  if (action==='inspect-cta' && keys==='action,copyUrl,page,project') {
    if (!await installed(db)) return {available:false,points:[],ctaRules:[]};
    const [points,rules]=await Promise.all([pointsForCopy(db,scope),rulesForCopy(db,scope)]);
    const executions=await db.query<{marker:string;surface:string;version:number;observed_at:string}>(`
      SELECT copy_cta->>'marker' AS marker, copy_cta->>'surface' AS surface,
        (copy_cta->>'version')::int AS version, max(received_at) AS observed_at
      FROM observed_action_facts
      WHERE project_id=$1 AND page_id=$2 AND copy_cta IS NOT NULL AND copy_cta->>'origin'=$3
        AND copy_cta->>'pathname'=$4 AND received_at>=clock_timestamp()-interval '7 days'
      GROUP BY 1,2,3`,scopeParameters(scope));
    return {available:true,points,ctaRules:rules.map(rule=>({...rule,execution_observed_at:executions.rows.find(
      row=>row.marker===rule.marker && row.surface===rule.surface && row.version===rule.version)?.observed_at ?? null}))};
  }
  const disable=action==='disable-cta';
  const modern=keys==='action,allocation,configGeneration,copyUrl,destination,displayName,marker,nativeDigest,page,project,revision,surface,urlGeneration';
  if ((!disable && action!=='confirm-cta') || ((!modern || disable) && keys!==(disable ? 'action,copyUrl,marker,page,project,revision,surface' :
      'action,configGeneration,copyUrl,destination,marker,nativeDigest,page,percent,project,revision,surface,urlGeneration')) ||
      typeof marker!=='string' || !markerPattern.test(marker) || typeof surface!=='string' || !surfacePattern.test(surface) ||
      !Number.isSafeInteger(revision)) throw new TypeError('invalid CTA rule');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await assertProjectAdministrativeWrite(client,project);
    await assertPageAdministrativeWrite(client,project,page);
    if (!await installed(client)) throw new PageConflict('CTA schema required');
    const rules=await rulesForCopy(client,scope);
    const prior=rules.find(rule=>rule.marker===marker && rule.surface===surface);
    if ((prior?.version ?? 0)!==revision) throw new PageConflict('CTA rule changed');
    if (disable) {
      if (!prior?.enabled) throw new PageConflict('no enabled CTA rule');
      await client.query(`INSERT INTO copy_cta_rules(project_id,page_id,copy_origin,copy_pathname,surface,marker,version,
        url_generation,config_generation,native_url,native_digest,destination,percent,enabled,allocation,display_name,discovery_required,activation_kind)
        SELECT project_id,page_id,copy_origin,copy_pathname,surface,marker,
          (SELECT max(version)+1 FROM copy_cta_rules WHERE project_id=$1),url_generation,config_generation,native_url,native_digest,destination,percent,false,allocation,display_name,discovery_required,activation_kind
        FROM copy_cta_rules WHERE project_id=$1 AND version=$2`,[project,prior.version]);
    } else {
      if (await isOfficialOrigin(client,copy.origin)) throw new TypeError('official copy origin forbidden');
      if (!prior && rules.length>=50) throw new PageConflict('CTA rule capacity');
      const result=await client.query(`SELECT pp.installation_id,pp.url_generation,pp.config_generation FROM protected_pages pp
        JOIN projects p ON p.id=pp.project_id JOIN protected_page_urls u ON u.page_id=pp.id
        WHERE pp.project_id=$1 AND pp.id=$2 AND pp.enabled AND pp.lifecycle_state='ACTIVE' AND p.lifecycle_state='ACTIVE'`,[project,page]);
      const current=result.rows[0];
      if (result.rowCount!==1 || current.url_generation!==input.urlGeneration || current.config_generation!==input.configGeneration) {
        throw new PageConflict('page configuration changed');
      }
      const distribution=await readDistribution(client,current.installation_id);
      if (!distribution || new URL(distribution.bases.TELEMETRY).origin!==gatewayOrigin ||
          (recheckPool && !await recheckPool(client,gatewayOrigin))) throw new PageConflict('CTA runtime configuration changed');
      const point=(await pointsForCopy(client,scope)).find(item=>item.marker===marker && item.surface===surface && item.native_digest===input.nativeDigest);
      if (!point?.native_url || point.compatible===false) throw new PageConflict('CTA observation changed');
      const protectedPoint=await client.query(`SELECT 1 FROM cta_points p LEFT JOIN cta_commercial_references r
        ON r.project_id=p.project_id AND r.point_id=p.id WHERE p.project_id=$1 AND p.marker=$2
        AND (p.surface=$3 OR $3='') AND (p.review_required OR r.point_id IS NOT NULL) LIMIT 1`,[project,marker,surface]);
      if (protectedPoint.rowCount) throw new PageConflict('CTA requires existing commercial review');
      const destination=normalizeHttpsAddress(input.destination);
      const legacyPercent=input.percent;
      if (!modern && (typeof legacyPercent!=='number' || !Number.isInteger(legacyPercent) ||
        legacyPercent<0 || legacyPercent>100)) throw new TypeError('invalid percentage');
      let allocation:Allocation;
      try {
        allocation=modern ? validateAllocation(input.allocation,1) : uniform(legacyPercent as number);
      } catch { throw new TypeError('invalid allocation'); }
      if (!modern && prior?.allocation && new Set(Object.values(prior.allocation)).size>1) {
        throw new PageConflict('CTA rule requires per-traffic allocation');
      }
      const percent=Math.min(...Object.values(allocation));
      const name=modern ? typeof input.displayName==='string' ? input.displayName.trim() : '' : prior?.display_name ?? null;
      if (modern && (!name || name.length>80 || /[\u0000-\u001f\u007f]/u.test(name))) throw new TypeError('invalid name');
      const activationKind=point.kind==='button' ? 'button' : 'a';
      const discoveryRequired=!!point.evidence && (point.evidence!=='marker' || activationKind==='button');
      await client.query(`INSERT INTO copy_cta_rules(project_id,page_id,copy_origin,copy_pathname,surface,marker,version,
        url_generation,config_generation,native_url,native_digest,destination,percent,enabled,allocation,display_name,discovery_required,activation_kind)
        SELECT $1,$2,$3,$4,$5,$6,COALESCE(max(version),0)+1,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16
        FROM copy_cta_rules WHERE project_id=$1`,[...scopeParameters(scope),surface,marker,current.url_generation,current.config_generation,
        point.native_url,point.native_digest,destination,percent,JSON.stringify(allocation),name,discoveryRequired,activationKind]);
    }
    await client.query('COMMIT');
    return {enabled:!disable};
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function listCtaRuleCopies(client:PoolClient,project:string,page:string) {
  if (!await installed(client)) return [];
  return (await client.query<{copy_origin:string;copy_pathname:string}>(`SELECT DISTINCT copy_origin,copy_pathname FROM copy_cta_rules
    WHERE project_id=$1 AND page_id=$2 ORDER BY copy_origin,copy_pathname`,[project,page])).rows;
}
