import type {Pool,PoolClient} from 'pg';

// Migration 080 consolidates deleted facts at the database boundary, and
// rejects legacy expiry statements. This maintenance also advances coverage.
export async function retainObservedMetrics(db:Pool|PoolClient,project:string){
 const schema=(await db.query(`SELECT to_regclass('observed_action_facts') IS NOT NULL facts,
   to_regclass('observed_decision_receipts') IS NOT NULL receipts,
   to_regclass('page_copy_contexts') IS NOT NULL copies,
   to_regclass('observed_daily_actions') IS NOT NULL daily,
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('observed_action_facts')
     AND tgname='observed_actions_expiry_guard' AND tgenabled IN ('O','A')) AS guarded`)).rows[0];
 if(schema.copies)await db.query("DELETE FROM page_copy_contexts WHERE project_id=$1 AND observed_at<clock_timestamp()-interval '30 days'",[project]);
 if(schema.daily) {
   if (!schema.guarded) throw new Error('observed expiry guard required');
   await db.query('SELECT expire_observed_facts($1)',[project]);
   await db.query("DELETE FROM observed_daily_actions WHERE project_id=$1 AND day<(statement_timestamp() AT TIME ZONE 'UTC')::date-90",[project]);
 } else if(schema.facts) {
   await db.query("DELETE FROM observed_action_facts WHERE project_id=$1 AND received_at<clock_timestamp()-interval '7 days'",[project]);
 }
 if(schema.receipts)await db.query("DELETE FROM observed_decision_receipts WHERE project_id=$1 AND prepared_at<clock_timestamp()-interval '7 days'",[project]);
}
