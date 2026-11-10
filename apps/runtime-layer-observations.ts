import type {Pool} from 'pg';
import type {PageContext} from './page-context.js';
import {optionalSchemas} from './optional-schema.js';
import {recordDegradationClaim,degradationState,markDegradationGap} from './degradation.js';
import {operationallyEligible} from './operational-eligibility.js';

export type RuntimeLayer='core'|'fallback'|'html_canary'|'css_canary';
export type LayerObserver=(context:PageContext,origin:string,source:RuntimeLayer,lost?:boolean)=>Promise<void>;

export async function scopedCorrelationOrigin(db:Pool,project:string,env:NodeJS.ProcessEnv):Promise<string|undefined> {
  const ids=(env.SCOPED_LAB_INSTALLATIONS??env.SCOPED_LAB_INSTALLATION??'').split(',').filter(Boolean);
  if(env.GATEWAY_MODE==='PILOT_OBSERVE'||!env.SCOPED_LAB_ORIGIN||!ids.length)return;
  const origin=new URL(env.SCOPED_LAB_ORIGIN);
  if(origin.origin!==env.SCOPED_LAB_ORIGIN||!['localhost','127.0.0.1'].includes(origin.hostname)||ids.length>100||ids.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))return;
  const pages=await db.query('SELECT 1 FROM protected_pages WHERE project_id=$1 AND installation_id=ANY($2::uuid[]) LIMIT 1',[project,ids]);
  return pages.rowCount?origin.origin:undefined;
}

// Reuse F44 correlation only inside the existing explicit controlled laboratory.
// No new visitor traits, operational risk score, or mitigation authority.
export function runtimeLayerObservations(db:Pool,env:NodeJS.ProcessEnv):LayerObserver {
  const ids=(env.SCOPED_LAB_INSTALLATIONS??env.SCOPED_LAB_INSTALLATION??'').split(',').filter(Boolean);
  const controlled=env.SCOPED_LAB_ORIGIN;
  let queue:Promise<void>=Promise.resolve(),pending=0;
  const states=new Map<string,{gapVersion:number;persisted:number;optional?:Awaited<ReturnType<typeof optionalSchemas>>}>();
  return async(context,origin,source,lost=false)=>{
    if(env.GATEWAY_MODE==='PILOT_OBSERVE'||!controlled||origin!==controlled||!ids.includes(context.installation)||context.urls.some(url=>url.origin===origin))return;
    // scopedGateway validates this configuration at startup; retain the boundary here too.
    if(ids.length>100||!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||context.urls.some(url=>!['localhost','127.0.0.1'].includes(new URL(url.origin).hostname)))return;
    let state=states.get(context.project);
    if(!state){state={gapVersion:1,persisted:0};states.set(context.project,state);}
    const current=state;
    if(lost)current.gapVersion++;
    if(pending>=100){current.gapVersion++;return;}
    pending++;
    const task=queue.then(async()=>{
      const optional=current.optional??(current.optional=await optionalSchemas(db));
      if(optional.canaryDegradation.state==='NOT_INSTALLED')return;
      const ok=await optional.canaryDegradation.run('scoped_layer',async()=>{
        const client=await db.connect();
        try{
          await client.query('BEGIN');
          if(!await operationallyEligible(client,context.project,context.page,true)){await client.query('ROLLBACK');return;}
          if(current.persisted!==current.gapVersion){const version=current.gapVersion;await markDegradationGap(db,context.project);current.persisted=version;}
          if(lost){await degradationState(db,context.project,new URL(origin).hostname,origin);await client.query('COMMIT');return;}
          await recordDegradationClaim(db,context.project,new URL(origin).hostname,source,origin);
          await degradationState(db,context.project,new URL(origin).hostname,origin);
          await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      });
      if(!ok)current.gapVersion++;
    }).catch(()=>{current.gapVersion++;process.stderr.write('scoped layer collection unavailable; uncertainty preserved\n');}).finally(()=>{pending--;});
    queue=task;await task;
  };
}
