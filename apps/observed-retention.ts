import type {Pool,PoolClient} from 'pg';

// A data-modifying CTE folds exactly the rows it deletes. Retries and competing
// maintainers cannot count a committed row again. Recent session IDs stay raw.
export async function retainObservedMetrics(db:Pool|PoolClient,project:string){
 const schema=(await db.query(`SELECT to_regclass('observed_action_facts') IS NOT NULL facts,
   to_regclass('observed_decision_receipts') IS NOT NULL receipts,
   to_regclass('page_copy_contexts') IS NOT NULL copies,
   to_regclass('observed_daily_actions') IS NOT NULL daily`)).rows[0];
 if(schema.copies)await db.query("DELETE FROM page_copy_contexts WHERE project_id=$1 AND observed_at<clock_timestamp()-interval '30 days'",[project]);
 if(schema.daily) {
   await db.query(`
     WITH expired AS (
       DELETE FROM observed_action_facts f
       WHERE project_id=$1 AND received_at<statement_timestamp()-interval '7 days'
       RETURNING project_id,page_id,(received_at AT TIME ZONE 'UTC')::date AS day, action,traffic_class,evidence,
         COALESCE(f.copy_cta->>'origin',f.session_copy->>'origin') AS copy_origin,
         COALESCE(f.copy_cta->>'pathname',f.session_copy->>'pathname') AS copy_path,
         f.copy_cta->>'marker' AS marker,f.copy_cta->>'surface' AS surface
     ), consolidated AS (
     INSERT INTO observed_daily_actions(project_id,page_id,day,action,traffic_class,evidence,copy_origin,copy_path,marker,surface,events)
     SELECT project_id,page_id,day,action,traffic_class,evidence,copy_origin,copy_path,marker,surface,count(*)
     FROM expired WHERE day >= (statement_timestamp() AT TIME ZONE 'UTC')::date-90
     GROUP BY project_id,page_id,day,action,traffic_class,evidence,copy_origin,copy_path,marker,surface
     ORDER BY project_id,page_id,day,action,traffic_class,evidence,copy_origin,copy_path,marker,surface
     ON CONFLICT (project_id,day,page_id,action,traffic_class,evidence,copy_origin,copy_path,marker,surface)
     DO UPDATE SET events=observed_daily_actions.events+EXCLUDED.events
     )
     INSERT INTO observed_daily_progress(project_id,complete_before)
     VALUES ($1, ((statement_timestamp()-interval '7 days') AT TIME ZONE 'UTC')::date)
     ON CONFLICT (project_id) DO UPDATE
     SET complete_before=EXCLUDED.complete_before
     WHERE observed_daily_progress.complete_before<EXCLUDED.complete_before
   `,[project]);
   await db.query("DELETE FROM observed_daily_actions WHERE project_id=$1 AND day<(statement_timestamp() AT TIME ZONE 'UTC')::date-90",[project]);
 } else if(schema.facts) {
   await db.query("DELETE FROM observed_action_facts WHERE project_id=$1 AND received_at<clock_timestamp()-interval '7 days'",[project]);
 }
 if(schema.receipts)await db.query("DELETE FROM observed_decision_receipts WHERE project_id=$1 AND prepared_at<clock_timestamp()-interval '7 days'",[project]);
}
