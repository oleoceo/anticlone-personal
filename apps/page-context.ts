import type { Pool, PoolClient } from 'pg';

export type PageContext = {project: string; page: string; installation: string; urls: {origin: string; pathname: string}[]};

// This lookup correlates a public installation identifier with server-owned
// configuration. It does not authenticate the caller or establish a clone.
export async function resolvePageContext(db: Pool | PoolClient, installation: string): Promise<PageContext | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installation)) return null;
  const result = await db.query(`SELECT p.id,p.project_id,p.installation_id,u.origin,u.pathname
    FROM protected_pages p LEFT JOIN protected_page_urls u ON u.page_id=p.id
    WHERE p.installation_id=$1 AND p.enabled ORDER BY u.origin,u.pathname`, [installation]);
  if (!result.rowCount) return null;
  const first = result.rows[0];
  return {project:first.project_id,page:first.id,installation:first.installation_id,
    urls:result.rows.filter(row => row.origin !== null).map(row => ({origin:row.origin,pathname:row.pathname}))};
}
