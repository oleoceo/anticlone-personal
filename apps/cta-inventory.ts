import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { approvedDestination } from './page-redirect.js';
import { tryIntent } from './notification-intents.js';

type Candidate = {marker: string | null; kind: string; parent: string; ordinal: number; url: string | null; context: string | null; amount: number | null; currency: string | null};
const offerPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const markerPattern = /^[a-zA-Z0-9_-]{8,64}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid body');
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: string): Record<string, unknown> {
  const data = object(value); if (Object.keys(data).sort().join(',') !== keys) throw Error('invalid fields'); return data;
}
function lab(origin: string) {
  if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw Error('laboratory only');
}
function observationUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u0020\\]/.test(value)) throw Error('invalid observed URL');
  const parsed = new URL(value);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('invalid observed URL');
  return parsed.href;
}
function candidates(body: unknown): {surface: string; rows: Candidate[]} {
  const data = fields(body,'candidates,surface');
  if (typeof data.surface !== 'string' || !offerPattern.test(data.surface)) throw Error('invalid surface');
  if (!Array.isArray(data.candidates) || data.candidates.length > 100) throw Error('invalid candidates');
  const rows = data.candidates.map((item: unknown) => {
    const row = object(item);
    if (!['kind,marker,ordinal,parent,url','context,kind,marker,ordinal,parent,url','commercial,context,kind,marker,ordinal,parent,url','commercial,kind,marker,ordinal,parent,url'].includes(Object.keys(row).sort().join(','))) throw Error('invalid fields');
    let amount: number | null = null, currency: string | null = null;
    if (row.commercial !== undefined && row.commercial !== null) {
      const commercial = fields(row.commercial,'amount,currency');
      if (!Number.isSafeInteger(commercial.amount) || (commercial.amount as number) < 0 || typeof commercial.currency !== 'string' || !/^[A-Z]{3}$/.test(commercial.currency)) throw Error('invalid commercial evidence');
      amount = commercial.amount as number; currency = commercial.currency;
    }
    if (row.context !== undefined && (typeof row.context !== 'string' || row.context.length>160 || /[\u0000-\u001f\u007f]/.test(row.context))) throw Error('invalid context');
    if (!['a','form','button'].includes(row.kind as string) || typeof row.parent !== 'string' || !/^[a-z]{1,20}$/.test(row.parent) || !Number.isInteger(row.ordinal) || (row.ordinal as number) < 1 || (row.ordinal as number) > 100 || !(row.marker === null || typeof row.marker === 'string' && markerPattern.test(row.marker))) throw Error('invalid candidate');
    return {marker: row.marker as string | null,kind:row.kind as string,parent:row.parent,ordinal:row.ordinal as number,url:observationUrl(row.url),context:typeof row.context === 'string' ? row.context : null,amount,currency};
  });
  return {surface:data.surface, rows};
}
export async function cleanupCta(db: Pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM cta_drift_alerts WHERE created_at < now() - interval '30 days'");
    await client.query("DELETE FROM cta_observations WHERE observed_at < now() - interval '7 days'");
    await client.query('DELETE FROM cta_points p WHERE NOT EXISTS (SELECT 1 FROM cta_observations o WHERE o.project_id=p.project_id AND o.point_id=p.id) AND NOT EXISTS (SELECT 1 FROM cta_mappings m WHERE m.project_id=p.project_id AND m.point_id=p.id)');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function importInventory(db: Pool, project: string, body: unknown) {
  const {rows,surface} = candidates(body); const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[project]);
    if (!p.rowCount) throw Error('invalid project'); lab(p.rows[0].origin);
    await client.query("DELETE FROM cta_observations WHERE project_id=$1 AND observed_at < now() - interval '7 days'",[project]);
    await client.query('DELETE FROM cta_points p WHERE p.project_id=$1 AND NOT EXISTS (SELECT 1 FROM cta_observations o WHERE o.project_id=p.project_id AND o.point_id=p.id) AND NOT EXISTS (SELECT 1 FROM cta_mappings m WHERE m.project_id=p.project_id AND m.point_id=p.id)',[project]);
    const count = await client.query('SELECT count(*)::int AS n FROM cta_observations WHERE project_id=$1',[project]);
    if (count.rows[0].n + rows.length > 1000) throw Error('inventory capacity');
    const capture = randomUUID();
    await client.query('UPDATE cta_captures SET is_current=false WHERE project_id=$1 AND surface=$2 AND is_current',[project,surface]);
    await client.query('INSERT INTO cta_captures(id,project_id,surface) VALUES($1,$2,$3)',[capture,project,surface]);
    const markers = new Map<string,number>();
    for (const row of rows) if (row.marker) markers.set(row.marker,(markers.get(row.marker) ?? 0)+1);
    for (const [marker, occurrences] of markers) if (occurrences > 1) { const alerts = await client.query(`WITH prior AS (SELECT id,review_required FROM cta_points WHERE project_id=$1 AND surface=$2 AND marker=$3), changed AS (
      UPDATE cta_points p SET review_required=true, review_after_observation=COALESCE((SELECT max(id) FROM cta_observations WHERE project_id=$1),0)
      WHERE p.project_id=$1 AND p.surface=$2 AND p.marker=$3 RETURNING p.project_id,p.id
    ) INSERT INTO cta_drift_alerts(project_id,point_id,reason)
      SELECT c.project_id,c.id,'MARKER_COLLISION' FROM changed c JOIN prior ON prior.id=c.id AND NOT prior.review_required JOIN cta_mappings m ON m.project_id=c.project_id AND m.point_id=c.id RETURNING id`,[project,surface,marker]);
      for (const alert of alerts.rows) await tryIntent(client, () => client.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1) ON CONFLICT DO NOTHING',[alert.id]));
    }
    for (const row of rows) {
      const unique = !!row.marker && markers.get(row.marker) === 1;
      let id: string | undefined;
      if (unique) {
        const existing = await client.query('SELECT id,kind FROM cta_points WHERE project_id=$1 AND surface=$2 AND marker=$3',[project,surface,row.marker]);
        if (existing.rowCount && existing.rows[0].kind === row.kind) id = existing.rows[0].id;
        else if (existing.rowCount) throw Error('marker kind conflict');
      }
      if (!id) {
        id = randomUUID();
        await client.query('INSERT INTO cta_points(project_id,id,surface,marker,kind) VALUES($1,$2,$3,$4,$5)',[project,id,surface,unique ? row.marker : null,row.kind]);
      }
      // Unknown URLs are not evidence of a destination change.
      if (unique && row.kind === 'a' && row.url !== null) {
        const alerts = await client.query(`WITH prior AS (SELECT review_required FROM cta_points WHERE project_id=$1 AND id=$2), changed AS (UPDATE cta_points p SET review_required=true, review_after_observation=COALESCE((SELECT max(id) FROM cta_observations WHERE project_id=$1),0)
          WHERE p.project_id=$1 AND p.id=$2
            AND EXISTS (SELECT 1 FROM cta_mappings m WHERE m.project_id=p.project_id AND m.point_id=p.id)
            AND (SELECT o.observed_url FROM cta_observations o WHERE o.project_id=p.project_id AND o.point_id=p.id AND o.confidence='HIGH' AND o.observed_url IS NOT NULL ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) IS DISTINCT FROM $3 RETURNING p.project_id,p.id)
          INSERT INTO cta_drift_alerts(project_id,point_id,reason) SELECT project_id,id,'DESTINATION_CHANGED' FROM changed CROSS JOIN prior WHERE NOT prior.review_required RETURNING id`,[project,id,row.url]);
        for (const alert of alerts.rows) await tryIntent(client, () => client.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1) ON CONFLICT DO NOTHING',[alert.id]));
      }
      await client.query('INSERT INTO cta_observations(project_id,point_id,evidence,confidence,observed_url,capture_id,selection_allowed,visual_context,commercial_amount,commercial_currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[project,id,`structural:${row.kind}:${row.parent}:ordinal:${row.ordinal}`,unique ? 'HIGH' : 'LOW',row.url,capture,row.marker === null || unique,row.context,row.amount,row.currency]);
    }
    const alerts = await client.query(`WITH assessed AS (
      SELECT r.project_id,r.point_id,r.suspension, CASE WHEN o.id IS NULL OR o.commercial_amount IS NULL THEN 'UNCERTAIN'
        WHEN o.commercial_amount <> r.amount OR o.commercial_currency <> r.currency THEN 'CHANGED' ELSE NULL END AS reason
      FROM cta_commercial_references r JOIN cta_points p ON p.project_id=r.project_id AND p.id=r.point_id
      LEFT JOIN cta_observations o ON o.project_id=r.project_id AND o.point_id=r.point_id AND o.capture_id=$3 AND o.confidence='HIGH' AND o.selection_allowed
      WHERE r.project_id=$1 AND p.surface=$2
    ), changed AS (
      UPDATE cta_commercial_references r SET suspension=CASE WHEN a.reason='CHANGED' THEN 'CHANGED' ELSE COALESCE(r.suspension,a.reason) END
      FROM assessed a WHERE r.project_id=a.project_id AND r.point_id=a.point_id AND a.reason IS NOT NULL
      RETURNING r.project_id,r.point_id,a.suspension AS previous,a.reason
    ) INSERT INTO cta_drift_alerts(project_id,point_id,reason)
      SELECT project_id,point_id,CASE reason WHEN 'CHANGED' THEN 'COMMERCIAL_CHANGED' ELSE 'COMMERCIAL_UNCERTAIN' END FROM changed WHERE previous IS NULL OR (previous='UNCERTAIN' AND reason='CHANGED') RETURNING id`,[project,surface,capture]);
    for (const alert of alerts.rows) await tryIntent(client, () => client.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1) ON CONFLICT DO NOTHING',[alert.id]));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function approveDestination(db: Pool, project: string, body: unknown) {
  const row = fields(body,'offer,url');
  if (typeof row.offer !== 'string' || !offerPattern.test(row.offer) || typeof row.url !== 'string') throw Error('invalid destination');
  const p = await db.query('SELECT origin FROM projects WHERE id=$1',[project]); if (!p.rowCount) throw Error('invalid project');
  lab(p.rows[0].origin); const url = approvedDestination(row.url,p.rows[0].origin); const id = randomUUID();
  await db.query('INSERT INTO cta_destinations(project_id,offer,id,url) VALUES($1,$2,$3,$4)',[project,row.offer,id,url]);
  return {id};
}

// An intent records a human choice only; it is never consumed by the runtime.
export async function selectObservation(db: Pool, body: unknown) {
  const row = fields(body,'captureId,destinationId,observationId,offer,pointId,project,surface');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (typeof row.project !== 'string' || !offerPattern.test(row.project) || typeof row.surface !== 'string' || !offerPattern.test(row.surface) || typeof row.offer !== 'string' || !offerPattern.test(row.offer) || typeof row.captureId !== 'string' || !uuid.test(row.captureId) || typeof row.pointId !== 'string' || !uuid.test(row.pointId) || typeof row.destinationId !== 'string' || !uuid.test(row.destinationId) || typeof row.observationId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.observationId) || BigInt(row.observationId)>9223372036854775807n) throw new TypeError('invalid selection');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const project=await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[row.project]);
    if (!project.rowCount) throw new TypeError('invalid project');
    lab(project.rows[0].origin);
    const result=await client.query(`SELECT o.observed_url FROM cta_captures c
      JOIN cta_observations o ON o.capture_id=c.id AND o.project_id=c.project_id
      JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id AND p.surface=c.surface
      JOIN cta_destinations d ON d.project_id=c.project_id AND d.offer=$6 AND d.id=$7
      WHERE c.project_id=$1 AND c.surface=$2 AND c.id=$3 AND c.is_current
      AND o.id=$4::bigint AND o.point_id=$5 AND o.selection_allowed AND o.observed_at>=clock_timestamp()-interval '7 days'
      AND p.kind='a' AND (p.offer IS NULL OR p.offer=$6) AND NOT p.review_required`,
    [row.project,row.surface,row.captureId,row.observationId,row.pointId,row.offer,row.destinationId]);
    if (!result.rowCount) throw new SelectionConflict();
    await client.query(`INSERT INTO cta_selection_intents(project_id,surface,capture_id,observation_id,point_id,offer,destination_id,observed_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.project,row.surface,row.captureId,row.observationId,row.pointId,row.offer,row.destinationId,result.rows[0].observed_url]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export class SelectionConflict extends Error {}
// Approval confirms exact current evidence and mapping under the same project lock as import.
export async function approveCommercial(db: Pool, body: unknown) {
  const row = fields(body,'amount,captureId,currency,destinationId,observationId,pointId,project,surface,version');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (typeof row.project !== 'string' || !offerPattern.test(row.project) || typeof row.surface !== 'string' || !offerPattern.test(row.surface) || typeof row.pointId !== 'string' || !uuid.test(row.pointId) || typeof row.captureId !== 'string' || !uuid.test(row.captureId) || typeof row.destinationId !== 'string' || !uuid.test(row.destinationId) || typeof row.observationId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.observationId) || BigInt(row.observationId)>9223372036854775807n || !Number.isSafeInteger(row.amount) || (row.amount as number)<0 || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) || !Number.isSafeInteger(row.version) || (row.version as number)<0) throw new TypeError('invalid commercial approval');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const project=await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[row.project]);
    if (!project.rowCount) throw new TypeError('invalid project');
    lab(project.rows[0].origin);
    const evidence=await client.query(`SELECT m.offer FROM cta_captures c
      JOIN cta_observations o ON o.project_id=c.project_id AND o.capture_id=c.id
      JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id AND p.surface=c.surface
      JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id AND m.offer=p.offer
      WHERE c.project_id=$1 AND c.surface=$2 AND c.id=$3 AND c.is_current AND o.id=$4::bigint AND p.id=$5
      AND p.kind='a' AND p.marker IS NOT NULL AND o.confidence='HIGH' AND o.selection_allowed
      AND o.observed_at>=clock_timestamp()-interval '7 days' AND m.destination_id=$6
      AND o.commercial_amount=$7 AND o.commercial_currency=$8`,[row.project,row.surface,row.captureId,row.observationId,row.pointId,row.destinationId,row.amount,row.currency]);
    if (!evidence.rowCount) throw new SelectionConflict();
    const current=await client.query('SELECT version,suspension FROM cta_commercial_references WHERE project_id=$1 AND point_id=$2',[row.project,row.pointId]);
    if ((current.rowCount ? current.rows[0].version : 0)!==row.version || (current.rowCount && !current.rows[0].suspension)) throw new SelectionConflict();
    const offer=evidence.rows[0].offer;
    await client.query(`INSERT INTO cta_commercial_references(project_id,point_id,offer,destination_id,amount,currency,observation_id,capture_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id,point_id) DO UPDATE SET amount=EXCLUDED.amount,currency=EXCLUDED.currency,observation_id=EXCLUDED.observation_id,capture_id=EXCLUDED.capture_id,version=cta_commercial_references.version+1,suspension=NULL`,[row.project,row.pointId,offer,row.destinationId,row.amount,row.currency,row.observationId,row.captureId]);
    await client.query('INSERT INTO cta_commercial_audit(project_id,point_id,offer,destination_id,capture_id,observation_id,amount,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[row.project,row.pointId,offer,row.destinationId,row.captureId,row.observationId,row.amount,row.currency]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function mapPoint(db: Pool, project: string, body: unknown) {
  const row = fields(body,'destinationId,offer,pointId');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (typeof row.offer !== 'string' || !offerPattern.test(row.offer) || typeof row.pointId !== 'string' || typeof row.destinationId !== 'string' || !uuid.test(row.pointId) || !uuid.test(row.destinationId)) throw Error('invalid mapping');
  const client = await db.connect();
  try {
    await client.query('BEGIN'); const p = await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[project]); if (!p.rowCount) throw Error('invalid project'); lab(p.rows[0].origin);
    const d = await client.query('SELECT id FROM cta_destinations WHERE project_id=$1 AND offer=$2 AND id=$3',[project,row.offer,row.destinationId]); if (!d.rowCount) throw Error('destination not approved for offer');
    const point = await client.query('UPDATE cta_points SET offer=$3 WHERE project_id=$1 AND id=$2 AND offer IS NULL RETURNING id',[project,row.pointId,row.offer]); if (!point.rowCount) throw Error('point unavailable');
    await client.query('INSERT INTO cta_mappings(project_id,point_id,offer,destination_id) VALUES($1,$2,$3,$4)',[project,row.pointId,row.offer,row.destinationId]); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

// Confirm the exact latest retained observation and existing approved mapping.
export async function reviewPoint(db: Pool, project: string, body: unknown) {
  const row = fields(body,'destinationId,observationId,pointId');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (typeof row.pointId !== 'string' || !uuid.test(row.pointId) || typeof row.destinationId !== 'string' || !uuid.test(row.destinationId) || typeof row.observationId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.observationId) || BigInt(row.observationId) > 9223372036854775807n) throw Error('invalid review');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT origin FROM projects WHERE id=$1 FOR UPDATE',[project]);
    if (!p.rowCount) throw Error('invalid project'); lab(p.rows[0].origin);
    const result = await client.query(`SELECT p.offer,o.observed_url FROM cta_points p JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id
      JOIN LATERAL (SELECT id,confidence,observed_url,observed_at FROM cta_observations WHERE project_id=p.project_id AND point_id=p.id ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
      WHERE p.project_id=$1 AND p.id=$2 AND p.kind='a' AND p.marker IS NOT NULL AND p.review_required
      AND m.destination_id=$3 AND o.id=$4::bigint AND o.id>p.review_after_observation AND o.confidence='HIGH' AND o.observed_url IS NOT NULL AND o.observed_at>=now()-interval '7 days'`,[project,row.pointId,row.destinationId,row.observationId]);
    if (!result.rowCount) throw Error('review evidence or mapping unavailable');
    await client.query('INSERT INTO cta_review_audit(project_id,point_id,observation_id,destination_id,offer,observed_url) VALUES($1,$2,$3,$4,$5,$6)',[project,row.pointId,row.observationId,row.destinationId,result.rows[0].offer,result.rows[0].observed_url]);
    await client.query('UPDATE cta_points SET review_required=false WHERE project_id=$1 AND id=$2',[project,row.pointId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
