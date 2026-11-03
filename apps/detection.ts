import type { Pool } from 'pg';
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
export async function cleanup(pool: Pool, project: string): Promise<void> {
  await pool.query("DELETE FROM observations WHERE project_id = $1 AND observed_at < now() - interval '7 days'", [project]);
  await pool.query("DELETE FROM observation_source_days WHERE project_id = $1 AND day < (now() AT TIME ZONE 'UTC')::date - 7", [project]);
  await pool.query("DELETE FROM observation_days WHERE project_id = $1 AND day < (now() AT TIME ZONE 'UTC')::date - 7", [project]);
  const expired = await pool.query(`DELETE FROM incidents WHERE project_id = $1 AND last_seen < now() - interval '30 days' RETURNING id`, [project]);
  if (expired.rowCount) process.stderr.write(`Expired ${expired.rowCount} inactive incident(s) and associated alerts under retention policy\n`);
}
export async function observe(pool: Pool, project: string, allowedOrigin: string, input: string, source: 'core' | 'fallback' = 'core'): Promise<'authorized' | 'observed' | 'capacity'> {
  const origin = configuredOrigin(input), host = hostFromUrl(origin);
  if (origin === allowedOrigin) return 'authorized';
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
    if (day.rowCount) await client.query('INSERT INTO observations (project_id, host, source) VALUES ($1, $2, $3)', [project, host, source]);
    await client.query('INSERT INTO alert_outbox(incident_id) VALUES ($1) ON CONFLICT DO NOTHING', [incident.rows[0].id]);
    await client.query('COMMIT'); return 'observed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
