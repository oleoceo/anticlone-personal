import type { Pool, PoolClient } from 'pg';

// Call with a transaction-scoped client and lock=true when a subsequent write
// must serialize with an administrative state transition.
export async function operationallyEligible(db: Pool | PoolClient, project: string, page?: string, lock = false): Promise<boolean> {
  const projectRow = await db.query(`SELECT lifecycle_state FROM projects WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [project]);
  if (projectRow.rows[0]?.lifecycle_state !== 'ACTIVE') return false;
  if (!page) return true;
  const pageRow = await db.query(`SELECT lifecycle_state,enabled FROM protected_pages WHERE project_id=$1 AND id=$2${lock ? ' FOR SHARE' : ''}`, [project, page]);
  return pageRow.rows[0]?.lifecycle_state === 'ACTIVE' && pageRow.rows[0]?.enabled === true;
}
