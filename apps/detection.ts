import {retainObservedMetrics} from './observed-retention.js';
import { notificationRetention } from './notification-lifecycle.js';
import { tryRecordTimeline } from './investigation-timeline.js';
import type { Pool, PoolClient } from 'pg';
import { tryIntent } from './notification-intents.js';
import { classifyTraffic } from './traffic.js';
export function hostFromUrl(input: string): string {
  if (Buffer.byteLength(input) > 2048) throw new Error('invalid URL');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.length > 253) throw new Error('invalid URL');
  return url.hostname.toLowerCase().replace(/\.$/, '');
}
export function configuredOrigin(input: string): string {
  hostFromUrl(input);
  const url = new URL(input);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('origin must not include path, query or fragment');
  url.hostname = url.hostname.replace(/\.$/, '');
  return url.origin;
}
export async function cleanup(db: Pool, project: string): Promise<void> {
  const pool=await db.connect();
  try {
  await pool.query('BEGIN');
  const retention=await notificationRetention(pool,project);
  await retainObservedMetrics(pool,project);
  const timeline = await pool.query("SELECT to_regclass('investigation_timeline') IS NOT NULL AS installed");
  if (timeline.rows[0].installed) await pool.query("DELETE FROM investigation_timeline WHERE project_id=$1 AND recorded_at < clock_timestamp()-interval '30 days'",[project]);
  await pool.query("DELETE FROM risk_assessment_days WHERE project_id = $1 AND observed_at < now() - interval '7 days'", [project]);
  await pool.query("DELETE FROM traffic_observation_days WHERE project_id = $1 AND observed_at < now() - interval '7 days'", [project]);
  await pool.query("DELETE FROM canary_observations WHERE project_id = $1 AND observed_at < now() - interval '7 days'", [project]);
  await pool.query("DELETE FROM observations WHERE project_id = $1 AND observed_at < now() - interval '7 days'", [project]);
  await pool.query("DELETE FROM observation_source_days WHERE project_id = $1 AND day < (now() AT TIME ZONE 'UTC')::date - 7", [project]);
  await pool.query("DELETE FROM observation_days WHERE project_id = $1 AND day < (now() AT TIME ZONE 'UTC')::date - 7", [project]);
  const expired = await pool.query(`DELETE FROM incidents i WHERE project_id = $1 AND last_seen < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM alert_outbox a WHERE a.incident_id=i.id AND a.sent_at IS NULL AND a.expired_at IS NULL AND (NOT $2 OR ($3::timestamptz IS NOT NULL AND i.first_seen<=$3))) RETURNING id`, [project,retention.active,retention.cutoff]);
  if (expired.rowCount) process.stderr.write(`Expired ${expired.rowCount} inactive incident(s) and associated alerts under retention policy\n`);
  await pool.query('COMMIT');
  } catch(error) { await pool.query('ROLLBACK'); throw error; } finally {pool.release();}
}
export async function observe(pool: Pool, project: string, allowedOrigin: string | readonly string[], input: string, source: 'core' | 'fallback' = 'core', evidence?: unknown): Promise<'authorized' | 'observed' | 'capacity'> {
  const origin = configuredOrigin(input), host = hostFromUrl(origin);
  if (typeof allowedOrigin === 'string' ? origin === allowedOrigin : allowedOrigin.includes(origin)) return 'authorized';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize admission per project, including across processes and restarts.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    const existing = await client.query('SELECT id FROM incidents WHERE project_id=$1 AND host=$2', [project, host]);
    if (!existing.rowCount) {
      const count = await client.query('SELECT count(*)::int AS n FROM incidents WHERE project_id=$1', [project]);
      if (count.rows[0].n >= 100) { await client.query('ROLLBACK'); return 'capacity'; }
    }
    const incident = await client.query(`INSERT INTO incidents (project_id, host) VALUES ($1, $2)
      ON CONFLICT (project_id, host) DO UPDATE SET last_seen = now() RETURNING id`, [project, host]);
    const day = await client.query(`INSERT INTO observation_source_days(project_id,host,day,source) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,$3)
      ON CONFLICT DO NOTHING RETURNING host`, [project, host, source]);
    if (day.rowCount) {
      const saved = await client.query('INSERT INTO observations (project_id, host, source) VALUES ($1, $2, $3) RETURNING id', [project, host, source]);
      await tryRecordTimeline(client, {project,host,type:existing.rowCount ? 'source_observed' : 'first_observation',source,provenance:'gateway',reference:'observation:'+saved.rows[0].id,summary:{claimed_host:host},confidence:'receipt_only',limitations:'Gateway received a browser claim; host and source do not establish identity or independence.'});
    }
    if (evidence !== undefined) {
      const traffic = classifyTraffic(evidence, origin);
      await client.query(`INSERT INTO traffic_observation_days(project_id,host,day,traffic_class,evidence,certainty,source)
        VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [project, host, traffic.trafficClass, traffic.evidence, traffic.certainty, traffic.source]);
    }
    await tryIntent(client, () => client.query(`INSERT INTO alert_outbox(incident_id,expired_at)
      SELECT id, CASE WHEN first_seen <= clock_timestamp()-interval '24 hours' THEN clock_timestamp() END
      FROM incidents WHERE id=$1 ON CONFLICT (incident_id) DO NOTHING`, [incident.rows[0].id]));
    await client.query('COMMIT'); return 'observed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Referer is an unauthenticated claim; never create an incident or alert from a canary.
export async function observeCanary(pool: Pool, project: string, referer: string | undefined, source: 'html_canary' | 'css_canary'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recordCanaryClaim(client,project,referer,source);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Reuse the caller's transaction and connection for installation-scoped collection.
export async function recordCanaryClaim(client:PoolClient,project:string,referer:string|undefined,source:'html_canary'|'css_canary') {
  let host='';
  try {if(referer)host=hostFromUrl(referer);}catch { /* Unknown remains unknown. */ }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[project]);
  await client.query(`INSERT INTO canary_observations(project_id,host,source,day)
    SELECT $1,$2,$3,(now() AT TIME ZONE 'UTC')::date WHERE
    (SELECT count(*) FROM canary_observations WHERE project_id=$1)<1400 ON CONFLICT DO NOTHING`,[project,host,source]);
}
