import type {Pool, PoolClient} from 'pg';

type Database = Pick<Pool | PoolClient, 'query'>;

function httpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(value)) throw new TypeError('invalid HTTPS origin');
  const url = new URL(value);
  if (!url.hostname.includes('.') || url.hostname.endsWith('.') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new TypeError('hostname required');
  return url.origin;
}

function authorized(origin: string, env: NodeJS.ProcessEnv) {
  const host = new URL(origin).hostname;
  if (env.ADMIN_PUBLIC_ORIGIN) {
    try {if (new URL(env.ADMIN_PUBLIC_ORIGIN).hostname === host) return false;} catch {return false;}
  }
  return (env.RUNTIME_TELEMETRY_POOL_ORIGINS ?? '').split(',').some(entry => {
    try {return httpsOrigin(entry.trim()) === origin;} catch {return false;}
  });
}

export async function listTelemetryOrigins(db: Database, env = process.env) {
  if (!(await db.query("SELECT to_regclass('telemetry_origins') IS NOT NULL AS installed")).rows[0].installed)
    return {installed:false, items:[]};
  const rows = (await db.query<{origin:string;enabled:boolean}>('SELECT origin,enabled FROM telemetry_origins ORDER BY origin')).rows;
  return {installed:true, items:rows.map(row => ({...row, authorized:authorized(row.origin, env)}))};
}

export async function telemetryOriginAdmin(db: Pool, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid request');
  const data = input as Record<string, unknown>;
  const origin = httpsOrigin(data.origin);
  if (data.action === 'register' && Object.keys(data).sort().join(',') === 'action,origin') {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7933,67)');
      const size = await client.query('SELECT count(*)::int AS count, coalesce(bool_or(origin=$1),false) AS exists FROM telemetry_origins',[origin]);
      if (size.rows[0].count >= 50 && !size.rows[0].exists) throw new TypeError('pool limit');
      await client.query('INSERT INTO telemetry_origins(origin) VALUES($1) ON CONFLICT DO NOTHING',[origin]);
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {client.release();}
  } else if (data.action === 'set-enabled' && Object.keys(data).sort().join(',') === 'action,enabled,origin' && typeof data.enabled === 'boolean') {
    const result = await db.query('UPDATE telemetry_origins SET enabled=$2,updated_at=clock_timestamp() WHERE origin=$1',[origin,data.enabled]);
    if (!result.rowCount) throw new TypeError('unknown origin');
  } else throw new TypeError('invalid action');
  return listTelemetryOrigins(db);
}

export async function telemetryOriginForPublication(db: PoolClient, origin: string, env: NodeJS.ProcessEnv) {
  if (!authorized(origin,env)) return false;
  const result = await db.query('SELECT enabled FROM telemetry_origins WHERE origin=$1 FOR SHARE',[origin]);
  return result.rows[0]?.enabled === true;
}
