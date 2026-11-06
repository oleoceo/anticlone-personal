import { recordTimeline } from './investigation-timeline.js';
import type { Pool } from 'pg';

export async function markDegradationGap(pool: Pool, project: string): Promise<void> {
  await pool.query(`INSERT INTO degradation_collection_gaps(project_id,last_dropped_at)
    VALUES($1,clock_timestamp()) ON CONFLICT(project_id)
    DO UPDATE SET last_dropped_at=EXCLUDED.last_dropped_at`, [project]);
}

// Current diagnosis is always evaluated from live evidence; audit rows are history only.
export async function maintainDegradation(pool: Pool, project: string, canaryOrigin?: string, hasCanarySchema = false): Promise<void> {
  await pool.query("DELETE FROM degradation_events WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '24 hours'", [project]);
  await pool.query("DELETE FROM degradation_audit WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '7 days'", [project]);
  if (hasCanarySchema) await pool.query("DELETE FROM degradation_collection_gaps WHERE project_id=$1 AND last_dropped_at < clock_timestamp()-interval '30 minutes'", [project]);
  // Only open historical transitions need an expiration transition. UNKNOWN hosts need no polling.
  const hosts = await pool.query(`SELECT host FROM (
    SELECT DISTINCT ON (host) host,state FROM degradation_audit
    WHERE project_id=$1 ORDER BY host,observed_at DESC
  ) latest WHERE state='POSSIBLE_DEGRADATION'`, [project]);
  for (const {host} of hosts.rows) await degradationState(pool, project, host, canaryOrigin);
}

// All browser-originated signals can be forged. These are claims, never proof of tampering.
export async function recordDegradationClaim(pool: Pool, project: string, host: string, source: 'core' | 'fallback' | 'html_canary' | 'css_canary', origin?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    await client.query("DELETE FROM degradation_events WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '24 hours'", [project]);
    await client.query("DELETE FROM degradation_audit WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '7 days'", [project]);
    if (origin) await client.query(`INSERT INTO degradation_collection_gaps(project_id,last_dropped_at)
      SELECT $1,clock_timestamp() WHERE (SELECT count(*) FROM degradation_events WHERE project_id=$1)>=10000
      ON CONFLICT(project_id) DO UPDATE SET last_dropped_at=EXCLUDED.last_dropped_at`, [project]);
    await client.query(`INSERT INTO degradation_events(project_id,host,source,bucket${origin ? ',origin' : ''})
      SELECT $1,$2,$3,date_trunc('minute',clock_timestamp())${origin ? ',$4' : ''}
      WHERE (SELECT count(*) FROM degradation_events WHERE project_id=$1)<10000
      ON CONFLICT DO NOTHING`, origin ? [project,host,source,origin] : [project,host,source]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function degradationState(pool: Pool, project: string, host: string, canaryOrigin?: string): Promise<'UNKNOWN' | 'POSSIBLE_DEGRADATION'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    const result = await client.query(`WITH t AS (SELECT clock_timestamp() AS now), evidence AS (
      SELECT count(*) FILTER (WHERE source='core' AND observed_at BETWEEN t.now-interval '30 minutes' AND t.now-interval '10 minutes') AS baseline,
      count(DISTINCT bucket) FILTER (WHERE source='core' AND observed_at BETWEEN t.now-interval '30 minutes' AND t.now-interval '10 minutes') AS baseline_buckets,
      count(*) FILTER (WHERE source='core' AND observed_at > t.now-interval '10 minutes') AS recent_core,
      count(DISTINCT bucket) FILTER (WHERE source='fallback' AND observed_at > t.now-interval '10 minutes') AS fallback_buckets,
      max(observed_at) FILTER (WHERE source='fallback') AS latest_fallback,
      ${canaryOrigin ? `count(DISTINCT bucket) FILTER (WHERE source='core' AND origin=$3 AND observed_at BETWEEN t.now-interval '30 minutes' AND t.now-interval '10 minutes') AS origin_baseline,
      count(DISTINCT bucket) FILTER (WHERE source IN ('html_canary','css_canary') AND origin=$3 AND observed_at > t.now-interval '10 minutes') AS canary_buckets,
      max(observed_at) FILTER (WHERE source IN ('html_canary','css_canary') AND origin=$3) AS latest_canary,
      jsonb_agg(jsonb_build_object('source',source,'origin',origin,'observed_at',observed_at) ORDER BY observed_at)
        FILTER (WHERE observed_at > t.now-interval '30 minutes') AS claims,` : ''} t.now
      FROM degradation_events CROSS JOIN t WHERE project_id=$1 AND host=$2 AND observed_at <= t.now GROUP BY t.now)
      SELECT (SELECT count(*) FROM degradation_events WHERE project_id=$1)<10000
        ${canaryOrigin ? "AND NOT EXISTS (SELECT 1 FROM degradation_collection_gaps WHERE project_id=$1 AND last_dropped_at>now-interval '30 minutes')" : ''} AND
        ((baseline >= 2 AND baseline_buckets >= 2 AND recent_core=0 AND fallback_buckets>=2
        AND latest_fallback > now-interval '2 minutes') ${canaryOrigin ? "OR (origin_baseline>=2 AND recent_core=0 AND canary_buckets>=2 AND latest_canary>now-interval '2 minutes')" : ''}) AS possible
        ${canaryOrigin ? ', claims' : ''} FROM evidence`, canaryOrigin ? [project,host,canaryOrigin] : [project,host]);
    const state = result.rows[0]?.possible === true ? 'POSSIBLE_DEGRADATION' : 'UNKNOWN';
    const previous = await client.query('SELECT state FROM degradation_audit WHERE project_id=$1 AND host=$2 ORDER BY observed_at DESC LIMIT 1',[project,host]);
    const written = await client.query(`INSERT INTO degradation_audit(project_id,host,state,window_start${canaryOrigin ? ',evidence' : ''})
      SELECT $1,$2,$3,clock_timestamp()-interval '30 minutes'${canaryOrigin ? ',$4::jsonb' : ''}
      WHERE (SELECT count(*) FROM degradation_audit WHERE project_id=$1)<10000
      AND COALESCE((SELECT state FROM degradation_audit WHERE project_id=$1 AND host=$2 ORDER BY observed_at DESC LIMIT 1),'')<>$3 RETURNING observed_at`, canaryOrigin ? [project,host,state,JSON.stringify(result.rows[0]?.claims ?? [])] : [project,host,state]);
    if (written.rowCount && (previous.rowCount || state==='POSSIBLE_DEGRADATION')) await recordTimeline(client,{project,host,type:'degradation_transition',source:'degradation_evaluator',provenance:'evaluator',summary:{from:previous.rows[0]?.state ?? 'unavailable',to:state},confidence:'uncertain',limitations:'Inference from potentially dependent unauthenticated signals; absence does not prove tampering.'});
    await client.query('COMMIT');
    return state;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
