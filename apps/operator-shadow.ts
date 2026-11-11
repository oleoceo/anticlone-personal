import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {operationallyEligible} from './operational-eligibility.js';
import {correlateActivity,sessionContext} from './authorized-activity.js';

export const evaluatorVersion='operator-shadow-v1';
export type OperatorSignal={
  kind:'activity'|'repeated_activity'|'traffic_claim'|'network_overlap'|'coarse_geo'|'contradiction'|'collection_gap'|'session_operator_fixture';
  source:'gateway'|'browser'|'authorized_import'|'controlled_lab';
  observedAt:number; validUntil:number; reference:string;
  scope:'group'|'session';
};
// No numerical probability is claimed before calibration against labeled real data.
// The only positive session evidence currently supported is an explicit lab fixture.
export function evaluateOperator(signals:readonly OperatorSignal[],now:number,controlledLab=false) {
  const sources=signals.slice(0,100).map(s=>({...s}));
  const current=sources.filter(s=>Number.isFinite(s.observedAt)&&Number.isFinite(s.validUntil)&&s.observedAt<=now&&s.validUntil>now&&s.validUntil>=s.observedAt);
  const blockers=current.filter(s=>s.kind==='contradiction'||s.kind==='collection_gap');
  const supporting=current.filter(s=>s.scope==='session'&&s.kind==='session_operator_fixture'&&s.source==='controlled_lab'&&controlledLab);
  const proposed=signals.length<=100&&supporting.length>0&&blockers.length===0;
  return {version:evaluatorVersion,mode:'SHADOW_ONLY',evaluatedAt:now,validUntil:Math.min(now+300000,...current.map(s=>s.validUntil)),
    group:{hypothesis:current.some(s=>s.scope==='group'&&s.kind==='repeated_activity')?'ACTIVITY_REQUIRES_INVESTIGATION':'INSUFFICIENT',operatorEstablished:false},
    session:{assessment:proposed?'PROBABLE_OPERATOR_LAB_ONLY':'INSUFFICIENT',confidence:proposed?'SYNTHETIC_ONLY':'UNCALIBRATED',probability:null},
    supporting:supporting.map(s=>s.reference),opposing:blockers.map(s=>s.reference),sources,
    limitations:[...(signals.length>100?['EVIDENCE_TRUNCATED_ABSTAIN']:[]),...(!sources.length?['NO_EVIDENCE']:[]),...(sources.length!==current.length?['EXPIRED_OR_INVALID_EVIDENCE']:[]),'NO_OPERATIONAL_SESSION_BOUND_SOURCE','NO_FIELD_CALIBRATION','CONTEXT_IS_NOT_IDENTITY'],
    v3Proposal:{contract:3,optInRequired:true,approvalRequired:true,wouldVetoIfEnabled:proposed,operationallyEligible:false},
    commercialDecisionChanged:false};
}

// Draft proposal only. Published validators continue rejecting v3.
export function proposeStealthV3(enabled:boolean,assessment:ReturnType<typeof evaluateOperator>,now:number) {
  return {contract:3,mode:'SHADOW_ONLY',wouldVeto:enabled&&assessment.validUntil>now&&assessment.evaluatedAt<=now&&assessment.v3Proposal.wouldVetoIfEnabled,
    operationalVeto:false,reason:enabled?'UNAPPROVED_SHADOW_CONTRACT':'STEALTH_OFF'};
}

export async function recordOperatorShadow(db:Pool,project:string,page:string,host:string,session:string,traffic:string,receivedAt:number) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    if(!(await client.query("SELECT to_regclass('operator_shadow_assessments') IS NOT NULL installed")).rows[0].installed){await client.query('ROLLBACK');return;}
    if(!await operationallyEligible(client,project,page,true)){await client.query('ROLLBACK');return;}
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[project]);
    const now=Number((await client.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS time')).rows[0].time);
    await client.query("DELETE FROM operator_shadow_assessments WHERE project_id=$1 AND recorded_at<clock_timestamp()-interval '7 days'",[project]);
    const key=sessionContext(project,page,host,session,receivedAt);
    const base=evaluateOperator([
      {kind:'activity',scope:'session',source:'gateway',observedAt:receivedAt,validUntil:receivedAt+300000,reference:'decision_request_received'},
      {kind:'traffic_claim',scope:'session',source:'browser',observedAt:receivedAt,validUntil:receivedAt+300000,reference:'unverified_'+traffic}
    ],now);
    const correlation=await correlateActivity(client,project,page,key,now);
    const assessment={...base,correlation,
      ...(correlation.wouldVetoIfApproved?{version:'operator-correlated-v1',session:{assessment:correlation.assessment,confidence:correlation.confidence,probability:null},
        supporting:correlation.supporting,opposing:correlation.opposing,validUntil:Math.min(base.validUntil,correlation.validUntil),
        limitations:correlation.limitations,v3Proposal:{...base.v3Proposal,wouldVetoIfEnabled:true}}:{})};
    const revision=createHash('sha256').update(JSON.stringify([correlation.assessment,correlation.supporting,correlation.opposing,correlation.limitations,correlation.enrichment])).digest('hex');
    await client.query(`INSERT INTO operator_shadow_assessments(project_id,page_id,host,session_context,bucket,assessment${correlation.available?',evidence_revision':''})
      SELECT $1,$2,$3,$4,date_trunc('minute',clock_timestamp()),$5::jsonb${correlation.available?',$6':''}
      WHERE (SELECT count(*) FROM operator_shadow_assessments WHERE project_id=$1)<10000
      ON CONFLICT DO NOTHING`,[project,page,host,key,JSON.stringify(assessment),...(correlation.available?[revision]:[])]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

// One bounded complementary queue per pool; never awaited by commercial decisions.
const queues=new WeakMap<Pool,{tail:Promise<void>;pending:number}>();
export async function settleOperatorShadow(db:Pool) {await queues.get(db)?.tail;}
export function scheduleOperatorShadow(...args:Parameters<typeof recordOperatorShadow>) {
  const db=args[0];if((db.options.max??10)<2)return;
  let queue=queues.get(db);if(!queue){queue={tail:Promise.resolve(),pending:0};queues.set(db,queue);}
  if(queue.pending>=100)return;
  const state=queue;state.pending++;
  state.tail=state.tail.then(()=>recordOperatorShadow(...args)).catch(()=>{process.stderr.write('Operator shadow history unavailable; coverage incomplete\n');}).finally(()=>{state.pending--;});
}
