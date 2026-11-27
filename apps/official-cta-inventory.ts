import type { Pool, PoolClient } from 'pg';
import type { validateCopyCtaInventory } from './copy-cta-rules.js';

type Points = ReturnType<typeof validateCopyCtaInventory>;
type Scope = {page: string; origin: string; pathname: string};
const installed = async (db: Pick<Pool, 'query'>) =>
  (await db.query("SELECT to_regclass('official_cta_inventory') IS NOT NULL AS ready")).rows[0].ready === true;

// Browser claims are visible for review only. Copy rules never read this table.
export async function rememberOfficialCtas(db: PoolClient, {page, origin, pathname}: Scope, points: Points) {
  if (!await installed(db)) return;
  await db.query(`
    INSERT INTO official_cta_inventory(page_id,origin,pathname,points)
    SELECT $1,$2,$3,coalesce(jsonb_agg(point || jsonb_build_object('seen_at',statement_timestamp())), '[]'::jsonb)
    FROM jsonb_array_elements($4::jsonb) point
    ON CONFLICT (page_id,origin,pathname) DO UPDATE SET
      observed_at=statement_timestamp(),
      points=(SELECT coalesce(jsonb_agg(recent.point), '[]'::jsonb) FROM (
        SELECT latest.point FROM (
          SELECT DISTINCT ON (point->>'surface',point->>'marker') point
          FROM (
            SELECT point FROM jsonb_array_elements(EXCLUDED.points) point
            UNION ALL
            SELECT point FROM jsonb_array_elements(official_cta_inventory.points) point
            WHERE (point->>'seen_at')::timestamptz >= statement_timestamp()-interval '7 days'
          ) batches ORDER BY point->>'surface',point->>'marker',(point->>'seen_at')::timestamptz DESC
        ) latest ORDER BY (latest.point->>'seen_at')::timestamptz DESC, latest.point->>'surface', latest.point->>'marker' LIMIT 50
      ) recent)`, [page, origin, pathname, JSON.stringify(points)]);
}

export async function inspectOfficialCtas(db: Pool, project: string, page: string) {
  if (!await installed(db)) return {available: false, captures: []};
  const {rows} = await db.query(`
    SELECT i.origin,i.pathname,i.observed_at,coalesce((
      SELECT jsonb_agg(point - 'seen_at' - 'native_digest') FROM jsonb_array_elements(i.points) point
      WHERE (point->>'seen_at')::timestamptz >= statement_timestamp()-interval '7 days'
    ), '[]'::jsonb) AS points
    FROM official_cta_inventory i JOIN protected_pages p ON p.id=i.page_id
    WHERE p.project_id=$1 AND p.id=$2 AND i.observed_at >= statement_timestamp()-interval '7 days'
    ORDER BY i.origin,i.pathname`, [project, page]);
  return {available: true, captures: rows};
}
