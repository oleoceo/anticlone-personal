import type { Pool, PoolClient } from 'pg';
import { configuredOrigin } from './detection.js';

export function validCopyPath(pathname:string) {
  if (!pathname.startsWith('/') || pathname.length>1024 || /[\s\\?#]/u.test(pathname)) return false;
  return new URL('https://copy.test'+pathname).pathname===pathname;
}
export const redirectVisit = /^[a-f0-9]{32}$/;
const browserPhases = new Set(['TIMEOUT','LATE_REDIRECT','REDIRECT_HANDOFF','PAGE_LEFT','OBSERVE_ONLY','REPLACE_CONVERSION',
  'CONTEXT_CHANGED','INVALID_REDIRECT','RUNTIME_ERROR','INTERACTION']);

type Context = {project: string; page: string};
type Scope = Context & {origin: string; pathname: string};

export async function copyContextsInstalled(db: Pick<Pool,'query'>) {
  return (await db.query("SELECT to_regclass('page_copy_contexts') IS NOT NULL AS ready")).rows[0].ready as boolean;
}

export async function rememberCopyContext(db: Pool, scope: Scope) {
  if (!scope.origin.startsWith('https://') || !validCopyPath(scope.pathname)) return;
  const client=await db.connect().catch(()=>null);
  if (!client) return;
  try {
    await client.query("BEGIN; SET LOCAL statement_timeout='200ms'");
    if (await copyContextsInstalled(client)) await insertObservedCopyContext(client,scope);
    await client.query('COMMIT');
    client.release();
  } catch {
    try {await client.query('ROLLBACK');client.release();} catch {client.release(true);}
  }
}

async function insertObservedCopyContext(client: PoolClient, scope: Scope) {
  const {project,page,origin,pathname}=scope;
  if (!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1),71) AS acquired',[page])).rows[0].acquired) return;
  await client.query("DELETE FROM page_copy_contexts WHERE project_id=$1 AND page_id=$2 AND observed_at<clock_timestamp()-interval '30 days'",[project,page]);
  await client.query(`INSERT INTO page_copy_contexts(project_id,page_id,copy_origin,copy_pathname)
    SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM protected_page_urls WHERE origin=$3)
      AND NOT EXISTS (SELECT 1 FROM projects WHERE origin=$3)
      AND ((SELECT count(*) FROM page_copy_contexts WHERE project_id=$1 AND page_id=$2)<200
        OR EXISTS (SELECT 1 FROM page_copy_contexts WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4))
    ON CONFLICT (project_id,page_id,copy_origin,copy_pathname) DO UPDATE SET observed_at=EXCLUDED.observed_at
    WHERE page_copy_contexts.observed_at<clock_timestamp()-interval '1 minute'`, [project,page,origin,pathname]);
}

export async function listCopyContexts(client: PoolClient, project: string, page: string) {
  if (!await copyContextsInstalled(client)) return null;
  return (await client.query(`SELECT copy_origin,copy_pathname,observed_at,gateway_at,gateway_action,gateway_reason,gateway_version,
      (gateway_at IS NOT NULL AND gateway_visit IS NULL) AS older_runtime,
      match.correlated AS browser_correlated,
      CASE WHEN match.correlated OR match.unmatched_failure THEN browser_at END AS browser_at,
      CASE WHEN match.correlated OR match.unmatched_failure THEN browser_phase END AS browser_phase,
      CASE WHEN match.correlated OR match.unmatched_failure THEN elapsed_ms END AS elapsed_ms
    FROM page_copy_contexts c CROSS JOIN LATERAL (SELECT
      COALESCE(browser_visit=gateway_visit AND (gateway_action='PAGE_REDIRECT' OR browser_phase NOT IN ('REDIRECT_HANDOFF','PAGE_LEFT','LATE_REDIRECT')),false) AS correlated,
      (browser_phase IN ('TIMEOUT','RUNTIME_ERROR','CONTEXT_CHANGED','INTERACTION') AND browser_at>COALESCE(gateway_at,'-infinity')) AS unmatched_failure
    ) match
    WHERE project_id=$1 AND page_id=$2 AND observed_at>=clock_timestamp()-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM protected_page_urls WHERE origin=c.copy_origin)
      AND NOT EXISTS (SELECT 1 FROM projects WHERE origin=c.copy_origin)
    ORDER BY observed_at DESC,copy_origin,copy_pathname`,[project,page])).rows;
}

// Admin inspection only. No reasons are sent to runtime callers.
export async function recordCopyDecision(db: Pool, scope: Scope, entry: {
  receivedAt: number; visit: string | null; action: string; reason: string; version: number | null;
}) {
  const {project,page,origin,pathname}=scope;
  try {
    await db.query(`UPDATE page_copy_contexts SET gateway_at=to_timestamp($5/1000.0),gateway_visit=$6,
      gateway_action=$7,gateway_reason=$8,gateway_version=$9
      WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4
      AND (gateway_at IS NULL OR gateway_at<=to_timestamp($5/1000.0))`,[project,page,origin,pathname,entry.receivedAt,
      entry.visit,entry.action,entry.reason,entry.version]);
  } catch { /* Observation must never delay or change a decision, including during a staged migration. */ }
}

export async function recordCopyBrowserOutcome(db: Pool, scope: Context, claimedOrigin: string, fields: Record<string,unknown>) {
  if (Object.keys(fields).sort().join(',')!=='elapsed,pathname,phase,visit' || typeof fields.pathname!=='string' ||
      !validCopyPath(fields.pathname) || typeof fields.visit!=='string' || !redirectVisit.test(fields.visit) ||
      typeof fields.phase!=='string' || !browserPhases.has(fields.phase) || typeof fields.elapsed!=='number' ||
      !Number.isInteger(fields.elapsed) || fields.elapsed<0 || fields.elapsed>60000) throw new TypeError('invalid runtime outcome');
  if (!await copyContextsInstalled(db)) return;
  const origin=configuredOrigin(claimedOrigin);
  await db.query(`UPDATE page_copy_contexts SET browser_at=clock_timestamp(),browser_visit=$5,browser_phase=$6,elapsed_ms=$7
    WHERE project_id=$1 AND page_id=$2 AND copy_origin=$3 AND copy_pathname=$4
      AND (browser_visit IS DISTINCT FROM $5 OR (
        browser_phase<>'PAGE_LEFT' AND (
          ($6='PAGE_LEFT' AND browser_phase='REDIRECT_HANDOFF') OR
          (browser_phase<>'REDIRECT_HANDOFF' AND elapsed_ms<=$7))))`,[scope.project,scope.page,origin,fields.pathname,
    fields.visit,fields.phase,fields.elapsed]);
}
