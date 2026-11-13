import {request} from 'node:http';
import type {Pool} from 'pg';
import {request as secureRequest} from 'node:https';
import {readFileSync} from 'node:fs';
import {recordOperationalState} from './health-alerts.js';

// Observe only the private loopback backend under a stable active-project and
// health-policy generation. No memory replay across pause/configuration changes.
export function localGatewayMonitor(db:Pool,env:NodeJS.ProcessEnv,now:()=>number=Date.now,signal?:AbortSignal){
  const npm=env.GATEWAY_TRANSPORT==='NPM_MTLS';
  const port=Number(env.MONITOR_GATEWAY_PORT??env.PORT??3000),proxy=env.GATEWAY_TRANSPORT==='HTTPS_PROXY'||npm,host=env.PUBLIC_GATEWAY_HOST;
  if(npm && env.MONITOR_GATEWAY_HOST!=='gateway')throw new TypeError('invalid NPM monitor target');
  const tls=npm?{ca:readFileSync(env.MONITOR_CA_FILE!),cert:readFileSync(env.MONITOR_CERT_FILE!),key:readFileSync(env.MONITOR_KEY_FILE!),servername:host}:{};
  if(env.MONITOR_LOCAL_GATEWAY!=='1'||!Number.isInteger(port)||port<1||port>65535||env.GATEWAY_TRANSPORT&&!proxy||proxy&&(!host||host.length>253||!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host)))throw new TypeError('invalid local gateway monitor configuration');
  const project=env.PROJECT_ID;
  if(project&&!/^[a-zA-Z0-9_-]{1,64}$/.test(project))throw new TypeError('invalid monitor project');
  let next=0,busy=false;
  return async()=>{
    if(signal?.aborted||busy||now()<next)return;busy=true;next=now()+60000;
    try{
      const snapshots:{id:string;generation:string;policy:string}[]=[];let after='';
      for(;;){
        const rows=await db.query(`SELECT p.id,(SELECT coalesce(max(id),0)::text FROM notification_pause_history WHERE project_id=p.id) AS generation,(SELECT coalesce(max(id),0)::text FROM health_settings_history WHERE project_id=p.id) AS policy FROM projects p JOIN installation_health_settings s ON s.project_id=p.id WHERE p.id>$1 AND ($2::text IS NULL OR p.id=$2) AND p.lifecycle_state='ACTIVE' AND p.deleted_at IS NULL AND s.operational_enabled ORDER BY p.id LIMIT 25`,[after,project??null]);
        if(!rows.rowCount)break;
        for(const row of rows.rows){if(snapshots.length>=1000)throw Error('local monitor capacity reached');snapshots.push(row);after=row.id;}
      }
      if(!snapshots.length||signal?.aborted)return;
      const healthy=await new Promise<boolean>(resolve=>{
        const headers=proxy?{host:host!,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'}:{};
        const req=(npm?secureRequest:request)({hostname:npm?'gateway':'127.0.0.1',port,path:'/healthz',method:'GET',headers,signal,...tls},res=>{
          let data='';res.on('data',chunk=>{data+=String(chunk);if(data.length>1024){res.destroy();resolve(false);}});res.on('error',()=>resolve(false));
          res.on('end',()=>{try{const value=JSON.parse(data);resolve(res.statusCode===200&&value.status==='ready'&&['LAB','PILOT_OBSERVE','OPERATIONAL'].includes(value.mode)&&['OBSERVE_ONLY','SCOPED_AUTHORIZATION_REQUIRED'].includes(value.action));}catch{resolve(false);}});
        });
        const timer=setTimeout(()=>{req.destroy();resolve(false);},2000);req.on('error',()=>resolve(false));req.on('close',()=>clearTimeout(timer));req.end();
      });
      const observedAt=new Date();
      for(const row of snapshots){
        if(signal?.aborted)return;
        try{
          await recordOperationalState(db,row.id,'gateway_local','LOCAL_BACKEND_HEALTH',!healthy,observedAt,async client=>{
            const current=await client.query(`SELECT 1 FROM installation_health_settings s WHERE s.project_id=$1 AND s.operational_enabled AND (SELECT coalesce(max(id),0)::text FROM notification_pause_history WHERE project_id=$1)=$2 AND (SELECT coalesce(max(id),0)::text FROM health_settings_history WHERE project_id=$1)=$3`,[row.id,row.generation,row.policy]);
            return !!current.rowCount;
          });
        }catch{process.stderr.write('local monitor project persistence failed; retry after probe interval\n');}
      }
    }finally{busy=false;}
  };
}
