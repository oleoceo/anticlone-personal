import type { Pool } from 'pg';

// Current diagnosis is always evaluated from live evidence; audit rows are history only.
export async function maintainDegradation(pool: Pool, project: string): Promise<void> {
  await pool.query("DELETE FROM degradation_events WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '24 hours'", [project]);
  await pool.query("DELETE FROM degradation_audit WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '7 days'", [project]);
  // Only open historical transitions need an expiration transition. UNKNOWN hosts need no polling.
  const hosts = await pool.query(`SELECT host FROM (
    SELECT DISTINCT ON (host) host,state FROM degradation_audit
    WHERE project_id=$1 ORDER BY host,observed_at DESC
  ) latest WHERE state='POSSIBLE_DEGRADATION'`, [project]);
  for (const {host} of hosts.rows) await degradationState(pool, project, host);
}

// All browser-originated signals can be forged. These are claims, never proof of tampering.
export async function recordDegradationClaim(pool: Pool, project: string, host: string, source: 'core' | 'fallback'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    await client.query("DELETE FROM degradation_events WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '24 hours'", [project]);
    await client.query("DELETE FROM degradation_audit WHERE project_id=$1 AND observed_at < clock_timestamp()-interval '7 days'", [project]);
    await client.query(`INSERT INTO degradation_events(project_id,host,source,bucket)
      SELECT $1,$2,$3,date_trunc('minute',clock_timestamp())
      WHERE (SELECT count(*) FROM degradation_events WHERE project_id=$1)<10000
      ON CONFLICT DO NOTHING`, [project,host,source]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function degradationState(pool: Pool, project: string, host: string): Promise<'UNKNOWN' | 'POSSIBLE_DEGRADATION'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    const result = await client.query(`WITH t AS (SELECT clock_timestamp() AS now), evidence AS (
      SELECT count(*) FILTER (WHERE source='core' AND observed_at BETWEEN t.now-interval '30 minutes' AND t.now-interval '10 minutes') AS baseline,
      count(DISTINCT bucket) FILTER (WHERE source='core' AND observed_at BETWEEN t.now-interval '30 minutes' AND t.now-interval '10 minutes') AS baseline_buckets,
      count(*) FILTER (WHERE source='core' AND observed_at > t.now-interval '10 minutes') AS recent_core,
      count(DISTINCT bucket) FILTER (WHERE source='fallback' AND observed_at > t.now-interval '10 minutes') AS fallback_buckets,
      max(observed_at) FILTER (WHERE source='fallback') AS latest_fallback, t.now
      FROM degradation_events CROSS JOIN t WHERE project_id=$1 AND host=$2 AND observed_at <= t.now GROUP BY t.now)
      SELECT baseline >= 2 AND baseline_buckets >= 2 AND recent_core=0 AND fallback_buckets>=2
        AND latest_fallback > now-interval '2 minutes' AS possible FROM evidence`, [project,host]);
    const state = result.rows[0]?.possible === true ? 'POSSIBLE_DEGRADATION' : 'UNKNOWN';
    await client.query(`INSERT INTO degradation_audit(project_id,host,state,window_start)
      SELECT $1,$2,$3,clock_timestamp()-interval '30 minutes'
      WHERE (SELECT count(*) FROM degradation_audit WHERE project_id=$1)<10000
      AND COALESCE((SELECT state FROM degradation_audit WHERE project_id=$1 AND host=$2 ORDER BY observed_at DESC LIMIT 1),'')<>$3`, [project,host,state]);
    await client.query('COMMIT');
    return state;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
