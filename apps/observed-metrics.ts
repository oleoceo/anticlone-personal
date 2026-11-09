import { operationallyEligible } from './operational-eligibility.js';
import type { Pool } from 'pg';
import { withProjectAdministrativeWrite } from './admin-project-write.js';

// Internal persistence contract. Browser claims never authenticate a sale or external load.
export type ObservedFact = {page:string;event:string;session:string;action:string;traffic:string;version:number|null;evidence:string};
export async function recordObservedFact(db:Pool, project:string, fact:ObservedFact) {
  if (!/^[a-f0-9]{32}$/.test(fact.session) || !['SESSION_OBSERVED','DECISION_PREPARED','PAGE_REDIRECT_ATTEMPT','CTA_CLICK_OBSERVED','CHECKOUT_HANDOFF_ATTEMPT'].includes(fact.action) || !['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN'].includes(fact.traffic) || !['BROWSER_UNVERIFIED','GATEWAY_PREPARED'].includes(fact.evidence) || (fact.action==='DECISION_PREPARED') !== (fact.evidence==='GATEWAY_PREPARED') || (fact.version!==null && (!Number.isSafeInteger(fact.version) || fact.version<1))) throw new TypeError('invalid fact');
  return withProjectAdministrativeWrite(db,project,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),47)',[project]);
    if(!await operationallyEligible(client,project,fact.page,true))throw new Error('inactive context');
    const prior=await client.query('SELECT page_id,session_id,action,traffic_class,policy_version,evidence FROM observed_action_facts WHERE project_id=$1 AND event_id=$2',[project,fact.event]);
    if(prior.rowCount){const row=prior.rows[0];if(row.page_id!==fact.page || row.session_id!==fact.session || row.action!==fact.action || row.traffic_class!==fact.traffic || row.policy_version!==fact.version || row.evidence!==fact.evidence)throw new TypeError('event conflict');return {duplicate:true};}
    await client.query("DELETE FROM observed_action_facts WHERE project_id=$1 AND received_at < clock_timestamp()-interval '7 days'",[project]);
    const count=await client.query("SELECT count(*)::int n FROM observed_action_facts WHERE project_id=$1 AND received_at>=clock_timestamp()-interval '7 days'",[project]);
    if(count.rows[0].n>=10000)throw new Error('fact capacity');
    await client.query('INSERT INTO observed_action_facts(project_id,page_id,event_id,session_id,action,traffic_class,policy_version,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[project,fact.page,fact.event,fact.session,fact.action,fact.traffic,fact.version,fact.evidence]);
    return {duplicate:false};
  });
}

export async function configureEstimate(db:Pool, project:string, ticket:number, rate:number, currency:string) {
  if(!Number.isSafeInteger(ticket)||ticket<0||ticket>1e12||!Number.isSafeInteger(rate)||rate<0||rate>10000||!/^[A-Z]{3}$/.test(currency))throw new TypeError('invalid assumptions');
  return withProjectAdministrativeWrite(db,project,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),47)',[project]);
    const result=await client.query('INSERT INTO estimate_assumptions(project_id,version,ticket_minor,conversion_basis_points,currency) SELECT $1,COALESCE(max(version),0)+1,$2,$3,$4 FROM estimate_assumptions WHERE project_id=$1 RETURNING *',[project,ticket,rate,currency]);
    return result.rows[0];
  });
}

export async function observedMetrics(db:Pool, project:string, page:string, from:string, until:string) {
  const start=Date.parse(from),end=Date.parse(until);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>7*86400000)throw new TypeError('invalid period');
  const result=await db.query(`SELECT traffic_class,action,evidence,policy_version,count(*)::int events,count(DISTINCT session_id)::int sessions FROM observed_action_facts WHERE project_id=$1 AND page_id=$2 AND received_at >= $3 AND received_at < $4 AND received_at >= clock_timestamp()-interval '7 days' GROUP BY traffic_class,action,evidence,policy_version ORDER BY traffic_class,action,policy_version`,[project,page,from,until]);
  const receiptsInstalled=(await db.query("SELECT to_regclass('observed_decision_receipts') IS NOT NULL installed")).rows[0].installed;
  const prepared=receiptsInstalled?(await db.query(`SELECT traffic_class,action,policy_version,count(*)::int decisions FROM observed_decision_receipts WHERE project_id=$1 AND page_id=$2 AND prepared_at >= $3 AND prepared_at < $4 AND prepared_at >= clock_timestamp()-interval '7 days' GROUP BY traffic_class,action,policy_version ORDER BY action,policy_version`,[project,page,from,until])).rows:null;
  const assumptions=(await db.query('SELECT version,ticket_minor,conversion_basis_points,currency,configured_at FROM estimate_assumptions WHERE project_id=$1 ORDER BY version DESC LIMIT 1',[project])).rows[0]??null;
  const clicks=result.rows.filter(row=>row.action==='CTA_CLICK_OBSERVED').reduce((sum,row)=>sum+row.events,0);
  return {prepared_decisions:prepared,source:'OBSERVED_CLAIMS',people:null,external_load_confirmed:null,recovered_revenue:null,rows:result.rows,assumptions,estimate:assumptions&&clicks>0?{label:'ESTIMATE',eligible_observed_clicks:clicks,amount_minor_numerator:(BigInt(clicks)*BigInt(assumptions.ticket_minor)*BigInt(assumptions.conversion_basis_points)).toString(),denominator:10000,currency:assumptions.currency}:null};
}
export async function metricsAdmin(db:Pool, body:unknown) {
 if(!body||typeof body!=='object'||Array.isArray(body))throw new TypeError('invalid metrics request');
 const data=body as Record<string,unknown>;
 if(typeof data.project!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(data.project))throw new TypeError('invalid project');
 if(data.action==='configure'&&Object.keys(data).sort().join(',')==='action,currency,project,rate,ticket'&&typeof data.ticket==='number'&&typeof data.rate==='number'&&typeof data.currency==='string')return configureEstimate(db,data.project,data.ticket,data.rate,data.currency);
 if(data.action==='query'&&Object.keys(data).sort().join(',')==='action,from,page,project,until'&&typeof data.page==='string'&&typeof data.from==='string'&&typeof data.until==='string')return observedMetrics(db,data.project,data.page,data.from,data.until);
 throw new TypeError('invalid metrics request');
}
