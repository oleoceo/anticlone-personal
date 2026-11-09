import type {Pool,PoolClient} from 'pg';
// Called from the existing periodic cleanup, including inactive projects.
export async function retainObservedMetrics(db:Pool|PoolClient,project:string){
 const schema=(await db.query("SELECT to_regclass('observed_action_facts') IS NOT NULL facts,to_regclass('observed_decision_receipts') IS NOT NULL receipts")).rows[0];
 if(schema.facts)await db.query("DELETE FROM observed_action_facts WHERE project_id=$1 AND received_at<clock_timestamp()-interval '7 days'",[project]);
 if(schema.receipts)await db.query("DELETE FROM observed_decision_receipts WHERE project_id=$1 AND prepared_at<clock_timestamp()-interval '7 days'",[project]);
}
