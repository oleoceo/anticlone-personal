import type {Pool, PoolClient} from 'pg';
import {PublicDnsFailure, publicHttpsBroker} from './installation-verifier.js';

// A 16-byte base64url token cannot end in '1'. Probe the real script location.
export const distributionHealthPath = '/assets/0000000000000000000001/a.js';

type Database = Pick<Pool | PoolClient, 'query'>;
type CheckStatus = 'OPERATIONAL' | 'DNS_FAILED' | 'HTTPS_FAILED' | 'GATEWAY_NOT_READY';
type EndpointRow = {origin:string;enabled:boolean;check_status:CheckStatus|null;checked_at:string|null;check_current:boolean};
type AffectedPage = {origin:string;project:string;projectName:string;page:string;pageName:string;lastRevision:number;historical:boolean};

function httpsOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 270 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(value)) throw new TypeError('invalid HTTPS origin');
  const url = new URL(value);
  if (url.hostname.length > 253 || !url.hostname.includes('.') || url.hostname.endsWith('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new TypeError('hostname required');
  return url.origin;
}

function authorized(origin: string, env: NodeJS.ProcessEnv) {
  const url = new URL(origin);
  if (url.port) return false;
  if (env.ADMIN_PUBLIC_ORIGIN) {
    try {if (new URL(env.ADMIN_PUBLIC_ORIGIN).hostname === url.hostname) return false;} catch {return false;}
  }
  return listedTelemetryOrigin(origin,env);
}

export function listedTelemetryOrigin(origin:string, env:NodeJS.ProcessEnv) {
  return (env.RUNTIME_TELEMETRY_POOL_ORIGINS ?? '').split(',').some(entry => {
    try {return httpsOrigin(entry.trim()) === origin;} catch {return false;}
  });
}

const checkFields = `to_jsonb(t)->>'check_status' AS check_status,
  to_jsonb(t)->>'checked_at' AS checked_at,
  coalesce((to_jsonb(t)->>'checked_at')::timestamptz >= t.updated_at,false) AS check_current`;

export async function listTelemetryOrigins(db: Database, env = process.env, includePages = false) {
  const {installed, verificationAvailable} = (await db.query<{installed:boolean;verificationAvailable:boolean}>(`
    SELECT to_regclass('telemetry_origins') IS NOT NULL AS installed,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('telemetry_origins')
        AND attname='checked_at' AND NOT attisdropped) AS "verificationAvailable"`)).rows[0];
  if (!installed) return {installed,verificationAvailable,items:[]};
  const rows = (await db.query<EndpointRow>(`SELECT t.origin,t.enabled,${checkFields} FROM telemetry_origins t ORDER BY t.created_at,t.origin`)).rows;
  const byOrigin = new Map<string, Omit<AffectedPage,'origin'>[]>();
  if (includePages && verificationAvailable && rows.length) {
    const affected = (await db.query<AffectedPage>(`
      WITH usage AS (
        SELECT origin,installation_id,max(version) AS last_revision
        FROM runtime_aliases WHERE origin=ANY($1::text[]) GROUP BY origin,installation_id
      )
      SELECT u.origin,p.project_id AS project,pr.name AS "projectName",p.id AS page,p.name AS "pageName",
        u.last_revision AS "lastRevision",
        EXISTS (SELECT 1 FROM runtime_distributions d
          WHERE d.installation_id=u.installation_id AND d.version>u.last_revision) AS historical
      FROM usage u JOIN protected_pages p USING(installation_id) JOIN projects pr ON pr.id=p.project_id
      ORDER BY u.origin,historical,pr.name,p.name,p.id`,[rows.map(row => row.origin)])).rows;
    for (const {origin,...page} of affected) {
      const pages = byOrigin.get(origin) ?? [];
      pages.push(page);
      byOrigin.set(origin,pages);
    }
  }
  return {installed,verificationAvailable,items:rows.map(row => {
    const allowed = authorized(row.origin,env);
    const state = !row.enabled ? 'DISABLED' : !allowed ? 'NOT_AUTHORIZED' :
      row.check_current && row.check_status ? row.check_status : 'UNVERIFIED';
    return {origin:row.origin,enabled:row.enabled,authorized:allowed,state,checkedAt:row.checked_at,
      affectedPages:byOrigin.get(row.origin) ?? []};
  })};
}

export async function checkTelemetryEndpoint(origin: string,
  request = publicHttpsBroker(undefined,undefined,{responseLimit:2048,returnHttpErrors:true})): Promise<CheckStatus> {
  let reply;
  try {
    reply = await request({url:origin+distributionHealthPath,method:'GET',body:''});
  } catch (error) {
    return error instanceof PublicDnsFailure ? 'DNS_FAILED' : 'HTTPS_FAILED';
  }
  if (reply.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(reply.headers['content-type'] ?? '')) return 'GATEWAY_NOT_READY';
  try {
    const health = JSON.parse(reply.body.toString());
    if (health?.status === 'ready' && health.mode === 'OPERATIONAL' && health.action === 'SCOPED_AUTHORIZATION_REQUIRED') return 'OPERATIONAL';
  } catch { /* An invalid health reply cannot admit publication. */ }
  return 'GATEWAY_NOT_READY';
}

export async function telemetryOriginAdmin(db: Pool, input: unknown, env = process.env,
  check: (origin:string)=>Promise<CheckStatus> = checkTelemetryEndpoint) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid request');
  const data = input as Record<string, unknown>;
  const origin = httpsOrigin(data.origin);
  const keys = Object.keys(data).sort().join(',');
  if (data.action === 'register' && keys === 'action,origin') {
    if (new URL(origin).port) throw new TypeError('standard HTTPS port required');
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
  } else if (data.action === 'set-enabled' && keys === 'action,enabled,origin' && typeof data.enabled === 'boolean') {
    const result = await db.query(`UPDATE telemetry_origins SET enabled=$2,
      updated_at=CASE WHEN enabled IS DISTINCT FROM $2 THEN clock_timestamp() ELSE updated_at END WHERE origin=$1`,[origin,data.enabled]);
    if (!result.rowCount) throw new TypeError('unknown origin');
  } else if (data.action === 'verify' && keys === 'action,origin') {
    if (!authorized(origin,env)) throw new TypeError('unauthorized telemetry origin');
    const before = (await db.query<{enabled:boolean;updated:string;checked:string|null}>(`
      SELECT enabled,updated_at::text AS updated,checked_at::text AS checked
      FROM telemetry_origins WHERE origin=$1`,[origin])).rows[0];
    if (!before?.enabled) throw new TypeError('inactive telemetry origin');
    const status = await check(origin);
    // A check in flight cannot undo a concurrent disable/re-enable or a newer result.
    await db.query(`UPDATE telemetry_origins SET check_status=$2,checked_at=clock_timestamp()
      WHERE origin=$1 AND enabled AND updated_at=$3::timestamptz AND checked_at IS NOT DISTINCT FROM $4::timestamptz`,
    [origin,status,before.updated,before.checked]);
  } else throw new TypeError('invalid action');
  return listTelemetryOrigins(db,env,true);
}

export async function telemetryOriginForPublication(db: PoolClient, origin: string, env: NodeJS.ProcessEnv) {
  if (!authorized(origin,env)) return false;
  const result = await db.query<EndpointRow>(`
    SELECT t.origin,t.enabled,${checkFields} FROM telemetry_origins t WHERE t.origin=$1 FOR SHARE`,[origin]);
  const row = result.rows[0];
  return row?.enabled && row.check_current && row.check_status === 'OPERATIONAL';
}
