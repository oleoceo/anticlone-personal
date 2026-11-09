import type { Pool, PoolClient } from 'pg';

// Call with a transaction-scoped client and lock=true when a subsequent write
// must serialize with an administrative state transition.
export async function operationallyEligible(db: Pool | PoolClient, project: string, page?: string, lock = false): Promise<boolean> {
  const catalog=await db.query("SELECT to_regclass('projects') IS NOT NULL AS installed");
  // Explicit pre-projects schema: there is no project lifecycle to consult.
  // Page-scoped operations cannot be authorized without the project catalog.
  if (!catalog.rows[0].installed) {
    const legacy=await db.query("SELECT to_regclass('incidents') IS NOT NULL AND to_regclass('protected_pages') IS NULL AND to_regclass('notification_pause_history') IS NULL AS installed");
    if (!legacy.rows[0].installed) throw new Error('project catalog unavailable');
    return page === undefined;
  }
  const schema = await db.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('projects') AND attname='lifecycle_state' AND NOT attisdropped) AS installed");
  if (!schema.rows[0].installed) {
    const legacy = await db.query(`SELECT id FROM projects WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [project]);
    if (legacy.rowCount !== 1) return false;
    if (!page) return true;
    const legacyPage=await db.query(`SELECT enabled FROM protected_pages WHERE project_id=$1 AND id=$2${lock ? ' FOR SHARE' : ''}`,[project,page]);
    return legacyPage.rows[0]?.enabled === true;
  }
  const projectRow = await db.query(`SELECT lifecycle_state FROM projects WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [project]);
  if (projectRow.rows[0]?.lifecycle_state !== 'ACTIVE') return false;
  if (!page) return true;
  const pageRow = await db.query(`SELECT lifecycle_state,enabled FROM protected_pages WHERE project_id=$1 AND id=$2${lock ? ' FOR SHARE' : ''}`, [project, page]);
  return pageRow.rows[0]?.lifecycle_state === 'ACTIVE' && pageRow.rows[0]?.enabled === true;
}

// Legacy requests carry no page identity. Admit them only when exactly one
// page exists, and lock it so a page pause serializes with the write.
export async function legacyOperationallyEligible(db: PoolClient, project: string): Promise<boolean> {
  if (!await operationallyEligible(db,project,undefined,true)) return false;
  const lifecycle=await db.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('projects') AND attname='lifecycle_state' AND NOT attisdropped) AS installed");
  if (!lifecycle.rows[0].installed) {
    const schema=await db.query("SELECT to_regclass('protected_pages') IS NOT NULL AS installed");
    if (!schema.rows[0].installed) return true;
    const pages=await db.query('SELECT enabled FROM protected_pages WHERE project_id=$1 FOR SHARE',[project]);
    return pages.rowCount===1 && pages.rows[0].enabled===true;
  }
  const pages=await db.query('SELECT id,lifecycle_state,enabled FROM protected_pages WHERE project_id=$1 FOR SHARE',[project]);
  return pages.rowCount===1 && pages.rows[0].enabled && pages.rows[0].lifecycle_state==='ACTIVE';
}
