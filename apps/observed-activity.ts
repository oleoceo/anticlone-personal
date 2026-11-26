import type {Pool} from 'pg';
import {configuredOrigin} from './detection.js';
import {validCopyPath} from './page-copy-contexts.js';

export function activityCopy(data: Record<string,unknown>, project: string|null, page: string|null) {
  if (data.copyOrigin===undefined && data.copyPath===undefined) return null;
  if (!project || !page || data.activity!==true || typeof data.copyOrigin!=='string' ||
      typeof data.copyPath!=='string' || !validCopyPath(data.copyPath)) throw new TypeError('invalid copy filter');
  try {
    return {origin:configuredOrigin(data.copyOrigin),pathname:data.copyPath};
  } catch {
    throw new TypeError('invalid copy origin');
  }
}

export async function observedActivity(db: Pool, filters: unknown[], copy: ReturnType<typeof activityCopy>) {
  const result=await db.query(`
    WITH period AS (
      SELECT f.*, COALESCE(to_jsonb(f)->'copy_cta'->>'origin', to_jsonb(f)->'session_copy'->>'origin') AS copy_origin,
        COALESCE(to_jsonb(f)->'copy_cta'->>'pathname', to_jsonb(f)->'session_copy'->>'pathname') AS copy_path,
        to_jsonb(f)->'copy_cta' AS point
      FROM observed_action_facts f
      WHERE ($1::text IS NULL OR project_id=$1) AND ($2::uuid IS NULL OR page_id=$2)
        AND received_at >= $3 AND received_at < $4 AND received_at >= statement_timestamp()-interval '7 days'
        AND ($5::text IS NULL OR traffic_class=$5)
        AND ($6::text IS NULL OR ($6='PAGE_REDIRECT' AND action='PAGE_REDIRECT_ATTEMPT')
          OR ($6='REPLACE_CONVERSION' AND action='CTA_CLICK_OBSERVED'))
    ), scoped AS (
      SELECT * FROM period WHERE $7::text IS NULL OR (copy_origin=$7 AND copy_path=$8)
    ), sessions AS (
      SELECT DISTINCT ON (project_id,session_id) * FROM scoped WHERE action='SESSION_OBSERVED'
      ORDER BY project_id,session_id,received_at,event_id
    ), activity AS (
      SELECT * FROM sessions UNION ALL SELECT * FROM scoped WHERE action<>'SESSION_OBSERVED'
    ), totals_by_day AS (
      SELECT project_id,page_id,traffic_class,action,evidence,(received_at AT TIME ZONE 'UTC')::date AS day,
        count(*)::int events,count(DISTINCT session_id)::int sessions FROM activity
      GROUP BY project_id,page_id,traffic_class,action,evidence,day
    ), points AS (
      SELECT project_id,page_id,copy_origin,copy_path,traffic_class,
        point->>'marker' AS marker,point->>'surface' AS surface,
        (array_agg(point->>'version' ORDER BY received_at DESC,event_id DESC))[1] AS version,
        count(*)::int clicks,count(DISTINCT session_id)::int sessions
      FROM scoped WHERE action='CTA_CLICK_OBSERVED' AND point->>'marker' IS NOT NULL
      GROUP BY project_id,page_id,copy_origin,copy_path,traffic_class,marker,surface
    ), copies AS (
      SELECT DISTINCT copy_origin AS origin,copy_path AS pathname FROM period
      WHERE $2 IS NOT NULL AND copy_origin IS NOT NULL AND copy_path IS NOT NULL
    )
    SELECT COALESCE((SELECT json_agg(d ORDER BY day,project_id,page_id,action,traffic_class) FROM totals_by_day d),'[]') AS observations,
      (SELECT count(DISTINCT (project_id,session_id))::int FROM scoped WHERE action='CTA_CLICK_OBSERVED') AS click_sessions,
      COALESCE((SELECT json_agg(c ORDER BY origin,pathname) FROM copies c),'[]') AS copies,
      COALESCE((SELECT json_agg(p ORDER BY clicks DESC,project_id,page_id,copy_origin,copy_path,marker,surface,traffic_class)
        FROM points p),'[]') AS cta_points
  `,[...filters,copy?.origin ?? null,copy?.pathname ?? null]);
  const activity=result.rows[0];
  if (activity.cta_points.length &&
      (await db.query("SELECT to_regclass('copy_cta_rules') IS NOT NULL AS ready")).rows[0].ready) {
    const aliases=(await db.query(`
      SELECT r.project_id,r.version,to_jsonb(r)->>'display_name' AS alias
      FROM jsonb_to_recordset($1::jsonb) AS p(project_id text,page_id uuid,copy_origin text,copy_path text,
        marker text,surface text,version int)
      JOIN copy_cta_rules r ON r.project_id=p.project_id AND r.page_id=p.page_id
        AND r.copy_origin=p.copy_origin AND r.copy_pathname=p.copy_path AND r.marker=p.marker
        AND r.surface=p.surface AND r.version=p.version
    `,[JSON.stringify(activity.cta_points)])).rows;
    const names=new Map(aliases.map(row=>[row.project_id+':'+row.version,row.alias]));
    for (const point of activity.cta_points) point.alias=names.get(point.project_id+':'+point.version) ?? null;
  }
  return activity;
}

export async function observedDailyHistory(db: Pool, filters: unknown[], copy: ReturnType<typeof activityCopy>) {
  const {rows:[{ready}]}=await db.query("SELECT to_regclass('observed_daily_actions') IS NOT NULL AS ready");
  if (!ready) return null;
  const result=await db.query(`
    WITH bounds AS (
      SELECT GREATEST(
        ((installed_at-interval '7 days') AT TIME ZONE 'UTC')::date+1,
        (statement_timestamp() AT TIME ZONE 'UTC')::date-90,
        ($3::timestamptz AT TIME ZONE 'UTC')::date+
          CASE WHEN ($3::timestamptz AT TIME ZONE 'UTC')::time='00:00' THEN 0 ELSE 1 END
      ) AS first_day, ($4::timestamptz AT TIME ZONE 'UTC')::date AS requested_end
      FROM observed_daily_installation
    ), coverage AS (
      SELECT p.id AS project_id, first_day,
        LEAST(requested_end,h.complete_before) AS complete_before
      FROM projects p CROSS JOIN bounds LEFT JOIN observed_daily_progress h ON h.project_id=p.id
      WHERE ($1::text IS NULL OR p.id=$1)
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM protected_pages l WHERE l.id=$2 AND l.project_id=p.id))
      AND h.complete_before IS NOT NULL
    ), eligible AS (
      SELECT a.* FROM observed_daily_actions a JOIN coverage c USING(project_id)
      WHERE a.day>=c.first_day AND a.day<c.complete_before AND ($2::uuid IS NULL OR a.page_id=$2)
      AND ($5::text IS NULL OR a.traffic_class=$5)
      AND ($6::text IS NULL OR ($6='PAGE_REDIRECT' AND a.action='PAGE_REDIRECT_ATTEMPT')
        OR ($6='REPLACE_CONVERSION' AND a.action='CTA_CLICK_OBSERVED'))
    ), copies AS (
      SELECT DISTINCT copy_origin AS origin,copy_path AS pathname FROM eligible
      WHERE $2::uuid IS NOT NULL AND copy_origin IS NOT NULL AND copy_path IS NOT NULL
      ORDER BY origin,pathname LIMIT 200
    ), totals AS (
      SELECT day, action, traffic_class, COALESCE(sum(events),0)::text AS events
      FROM eligible WHERE $7::text IS NULL OR (copy_origin=$7 AND copy_path=$8)
      GROUP BY day,action,traffic_class
    )
    SELECT COALESCE((SELECT json_agg(c ORDER BY project_id) FROM coverage c WHERE first_day<complete_before),'[]') AS coverage,
      COALESCE((SELECT json_agg(t ORDER BY day,action,traffic_class) FROM totals t),'[]') AS days,
      COALESCE((SELECT json_agg(c ORDER BY origin,pathname) FROM copies c),'[]') AS copies
  `,[...filters,copy?.origin ?? null,copy?.pathname ?? null]);
  return result.rows[0];
}
