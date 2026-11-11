import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {withProjectAdministrativeWrite,assertPageAdministrativeWrite} from './admin-project-write.js';
import {operationallyEligible} from './operational-eligibility.js';

export type Activity={version:1;id:string;project:string;page:string;source:string;actor:string;observedAt:number;
  kind:'RESOURCE_REQUEST'|'CHECKOUT_CHANGED'|'ISSUED_TEST_CONTEXT'|'CONTRADICTION'|'SOURCE_GAP';
  resource?:'HTML'|'SCRIPT'|'STYLE'|'IMAGE';session?:string;host?:string;country?:string;network?:'RESIDENTIAL'|'HOSTING'|'UNKNOWN'};
export type ActivitySource={id:string;project:string;page:string;key:string;sessionContinuity:boolean};
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hex=/^[a-f0-9]{64}$/;
// Sorted, closed schema; signatures cover every field and the version/domain.
export function activityBytes(event:Activity) {return 'anticlone-authorized-activity-v1\n'+JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a],[b])=>a.localeCompare(b))));}
export function signActivity(event:Activity,key:string) {return createHmac('sha256',key).update(activityBytes(event)).digest('hex');}
// A source must issue the test context, never endorse a browser-selected session.
// Domain-separated derivation prevents an adapter from signing an arbitrary lead
// session by mistake. Public replay/sharing still prevents operational authority.
export function issueActivitySession(event:Pick<Activity,'id'|'project'|'page'|'source'|'actor'|'observedAt'|'host'>,key:string) {
  return createHmac('sha256',key).update('anticlone-issued-test-v1\n'+JSON.stringify([event.id,event.project,event.page,event.source,event.actor,event.observedAt,event.host])).digest('hex').slice(0,32);
}
export function sessionContext(project:string,page:string,host:string,session:string,time:number) {
  return createHash('sha256').update(JSON.stringify([project,page,host,Math.floor(time/86400000),session])).digest('hex');
}
function validate(input:unknown,source:ActivitySource,now:number):Activity {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid activity');
  const e=input as Activity;
  if(Object.keys(e).some(k=>!['version','id','project','page','source','actor','observedAt','kind','resource','session','host','country','network'].includes(k))||
    e.version!==1||!uuid.test(e.id)||!uuid.test(e.page)||e.project!==source.project||e.page!==source.page||e.source!==source.id||
    !hex.test(e.actor)||!Number.isSafeInteger(e.observedAt)||e.observedAt>now||e.observedAt<now-7*86400000||
    !['RESOURCE_REQUEST','CHECKOUT_CHANGED','ISSUED_TEST_CONTEXT','CONTRADICTION','SOURCE_GAP'].includes(e.kind)||
    (e.country!==undefined&&!/^[A-Z]{2}$/.test(e.country))||(e.network!==undefined&&!['RESIDENTIAL','HOSTING','UNKNOWN'].includes(e.network)))throw new TypeError('invalid activity');
  if(e.kind==='RESOURCE_REQUEST'?!['HTML','SCRIPT','STYLE','IMAGE'].includes(e.resource!):e.resource!==undefined)throw new TypeError('invalid resource');
  const bound=e.kind==='ISSUED_TEST_CONTEXT';
  if(bound?(source.sessionContinuity!==true||typeof e.session!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(e.session)||typeof e.host!=='string'||! /^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(e.host)):(e.session!==undefined||e.host!==undefined))throw new TypeError('invalid session continuity');
  if(bound&&e.session!==issueActivitySession(e,source.key))throw new TypeError('invalid issued context');
  return e;
}
export async function ingestActivity(db:Pool,input:unknown,signature:string,source:ActivitySource) {
  // Source configuration is local administrator configuration, never request data.
  if(typeof source.key!=='string'||source.key.length<32||typeof signature!=='string'||!hex.test(signature))throw new TypeError('invalid source signature');
  const event=validate(input,source,Date.now());
  if(!timingSafeEqual(Buffer.from(signActivity(event,source.key),'hex'),Buffer.from(signature,'hex')))throw new TypeError('invalid source signature');
  const digest=createHash('sha256').update(activityBytes(event)).digest('hex');
  return withProjectAdministrativeWrite(db,event.project,async client=>{
    await assertPageAdministrativeWrite(client,event.project,event.page);
    if(!await operationallyEligible(client,event.project,event.page,true))throw new TypeError('inactive context');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[event.project]);
    await client.query("DELETE FROM authorized_activity WHERE project_id=$1 AND observed_at<clock_timestamp()-interval '7 days'",[event.project]);
    const prior=(await client.query('SELECT digest FROM authorized_activity WHERE project_id=$1 AND source=$2 AND event_id=$3',[event.project,event.source,event.id])).rows[0];
    if(prior){if(prior.digest!==digest)throw new TypeError('conflicting replay');return {state:'DUPLICATE'};}
    if(Number((await client.query('SELECT count(*) n FROM authorized_activity WHERE project_id=$1',[event.project])).rows[0].n)>=10000)throw new TypeError('activity capacity exceeded');
    // Drop raw public session identifiers after deriving a scoped daily context.
    const context=event.session?sessionContext(event.project,event.page,event.host!,event.session,event.observedAt):null;
    const actorContext=createHmac('sha256',source.key).update(JSON.stringify([event.project,event.page,event.source,Math.floor(event.observedAt/86400000),event.actor])).digest('hex');
    const payload={...event,session:undefined,actor:undefined};
    await client.query(`INSERT INTO authorized_activity(project_id,page_id,source,event_id,actor_context,session_context,observed_at,payload,digest)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8,$9)`,[event.project,event.page,event.source,event.id,actorContext,context,event.observedAt,JSON.stringify(payload),digest]);
    return {state:'IMPORTED'};
  });
}

export async function correlateActivity(db:Pool|PoolClient,project:string,page:string,context:string,now:number) {
  const unavailable={available:false,version:'authorized-correlation-v1',assessment:'INSUFFICIENT',confidence:'UNCALIBRATED',probability:null,validUntil:now,
    supporting:[] as string[],opposing:[] as string[],groupHypothesis:'INSUFFICIENT',enrichment:{country:'UNAVAILABLE',network:'UNAVAILABLE'},limitations:['NO_AUTHENTICATED_SESSION_CONTINUITY','CONTEXT_IS_NOT_IDENTITY','NO_FIELD_CALIBRATION'],wouldVetoIfApproved:false};
  if(!(await db.query("SELECT to_regclass('authorized_activity') IS NOT NULL installed")).rows[0].installed)return unavailable;
  unavailable.available=true;
  // Only an explicitly authorized server can assert authenticated continuity.
  // Browser session strings, network overlap and resource tokens cannot do so.
  const bindings=(await db.query(`SELECT * FROM authorized_activity WHERE project_id=$1 AND page_id=$2 AND session_context=$3
    AND observed_at<=to_timestamp($4/1000.0) AND observed_at>to_timestamp($4/1000.0)-interval '5 minutes' ORDER BY observed_at DESC LIMIT 2`,[project,page,context,now])).rows;
  if(bindings.length!==1)return {...unavailable,limitations:[bindings.length?'AMBIGUOUS_SESSION_BINDING':'NO_AUTHENTICATED_SESSION_CONTINUITY',...unavailable.limitations.slice(1)]};
  const binding=bindings[0];
  const rows=(await db.query(`SELECT payload,event_id,observed_at FROM authorized_activity WHERE project_id=$1 AND page_id=$2 AND source=$3 AND (actor_context=$4 OR payload->>'kind'='SOURCE_GAP')
    AND observed_at<=to_timestamp($5/1000.0) AND observed_at>to_timestamp($5/1000.0)-interval '30 minutes' ORDER BY observed_at,event_id LIMIT 101`,[project,page,binding.source,binding.actor_context,now])).rows;
  const resources=rows.filter(r=>r.payload.kind==='RESOURCE_REQUEST'&&new Date(r.observed_at)<=new Date(binding.observed_at));
  const edits=rows.filter(r=>r.payload.kind==='CHECKOUT_CHANGED'&&resources.some(s=>new Date(s.observed_at)<new Date(r.observed_at))&&new Date(r.observed_at)<new Date(binding.observed_at));
  const opposing=rows.filter(r=>['CONTRADICTION','SOURCE_GAP'].includes(r.payload.kind)).map(r=>r.event_id as string);
  const supported=new Set(resources.map(r=>r.payload.resource)).size>=3&&resources.some(r=>r.payload.resource==='HTML')&&edits.length>0;
  const proposed=supported&&!opposing.length&&rows.length<=100;
  return {...unavailable,assessment:proposed?'PROBABLE_COPY_TEST_SESSION':'INSUFFICIENT',validUntil:Math.min(new Date(binding.observed_at).getTime()+300000,...rows.map(r=>new Date(r.observed_at).getTime()+1800000)),
    supporting:[...resources,...edits,{event_id:binding.event_id}].map(r=>r.event_id as string),opposing,
    groupHypothesis:resources.length?'ORIGINAL_ACTIVITY_PRECEDES_AUTHENTICATED_TEST':'INSUFFICIENT',
    enrichment:{country:binding.payload.country??'UNAVAILABLE',network:binding.payload.network??'UNAVAILABLE'},
    limitations:['SOURCE_ISSUED_TEST_CONTEXT_NOT_HUMAN_IDENTITY','RESOURCE_REQUEST_NOT_COMPLETE_DOWNLOAD','SOURCE_COMPROMISE_OR_SHARED_CONTEXT_CAN_MISLEAD','PUBLIC_SESSION_REPLAY_REMAINS_POSSIBLE','NO_FIELD_CALIBRATION',...(rows.length>100?['EVIDENCE_TRUNCATED_ABSTAIN']:[])],wouldVetoIfApproved:proposed};
}
