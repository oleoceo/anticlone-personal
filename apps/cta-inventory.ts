import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { approvedDestination } from './page-redirect.js';

type Candidate = {marker: string | null; kind: string; parent: string; ordinal: number; url: string | null};
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
    const row = fields(item,'kind,marker,ordinal,parent,url');
    if (!['a','form','button'].includes(row.kind as string) || typeof row.parent !== 'string' || !/^[a-z]{1,20}$/.test(row.parent) || !Number.isInteger(row.ordinal) || (row.ordinal as number) < 1 || (row.ordinal as number) > 100 || !(row.marker === null || typeof row.marker === 'string' && markerPattern.test(row.marker))) throw Error('invalid candidate');
    return {marker: row.marker as string | null,kind:row.kind as string,parent:row.parent,ordinal:row.ordinal as number,url:observationUrl(row.url)};
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
    const markers = new Map<string,number>();
    for (const row of rows) if (row.marker) markers.set(row.marker,(markers.get(row.marker) ?? 0)+1);
    for (const [marker, occurrences] of markers) if (occurrences > 1) await client.query(`WITH prior AS (SELECT id,review_required FROM cta_points WHERE project_id=$1 AND surface=$2 AND marker=$3), changed AS (
      UPDATE cta_points p SET review_required=true, review_after_observation=COALESCE((SELECT max(id) FROM cta_observations WHERE project_id=$1),0)
      WHERE p.project_id=$1 AND p.surface=$2 AND p.marker=$3 RETURNING p.project_id,p.id
    ) INSERT INTO cta_drift_alerts(project_id,point_id,reason)
      SELECT c.project_id,c.id,'MARKER_COLLISION' FROM changed c JOIN prior ON prior.id=c.id AND NOT prior.review_required JOIN cta_mappings m ON m.project_id=c.project_id AND m.point_id=c.id`,[project,surface,marker]);
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
        await client.query(`WITH prior AS (SELECT review_required FROM cta_points WHERE project_id=$1 AND id=$2), changed AS (UPDATE cta_points p SET review_required=true, review_after_observation=COALESCE((SELECT max(id) FROM cta_observations WHERE project_id=$1),0)
          WHERE p.project_id=$1 AND p.id=$2
            AND EXISTS (SELECT 1 FROM cta_mappings m WHERE m.project_id=p.project_id AND m.point_id=p.id)
            AND (SELECT o.observed_url FROM cta_observations o WHERE o.project_id=p.project_id AND o.point_id=p.id AND o.confidence='HIGH' AND o.observed_url IS NOT NULL ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) IS DISTINCT FROM $3 RETURNING p.project_id,p.id)
          INSERT INTO cta_drift_alerts(project_id,point_id,reason) SELECT project_id,id,'DESTINATION_CHANGED' FROM changed CROSS JOIN prior WHERE NOT prior.review_required`,[project,id,row.url]);
      }
      await client.query('INSERT INTO cta_observations(project_id,point_id,evidence,confidence,observed_url) VALUES($1,$2,$3,$4,$5)',[project,id,`structural:${row.kind}:${row.parent}:ordinal:${row.ordinal}`,unique ? 'HIGH' : 'LOW',row.url]);
    }
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
