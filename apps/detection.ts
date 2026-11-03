import type { Pool } from 'pg';
export function hostFromUrl(input: string): string {
  if (input.length > 2048) throw new Error('invalid URL');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid URL');
  return url.hostname.toLowerCase().replace(/\.$/, '');
}
export async function observe(pool: Pool, project: string, allowedOrigin: string, input: string): Promise<'authorized' | 'observed'> {
  const host = hostFromUrl(input);
  if (new URL(input).origin === allowedOrigin) return 'authorized';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO observations (project_id, host) VALUES ($1, $2)', [project, host]);
    await client.query(`INSERT INTO incidents (project_id, host) VALUES ($1, $2) ON CONFLICT (project_id, host) DO UPDATE SET last_seen = now()`, [project, host]);
    await client.query('COMMIT'); return 'observed';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
