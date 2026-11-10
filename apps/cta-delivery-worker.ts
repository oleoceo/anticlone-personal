import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { deliverCtaAlert } from './cta-delivery.js';
import { sendLocalCtaAlert } from './cta-local-smtp.js';
import {deliverProviderCta} from './cta-delivery.js';
import {smtpProvider} from './smtp-provider.js';
import {deliverOne} from './alerts.js';
import {deliverHealth} from './health-alerts.js';
import {localGatewayMonitor} from './local-gateway-monitor.js';

const provider=smtpProvider(process.env);
if(!provider&&process.env.NOTIFICATION_WORKER_MODE==='PROVIDER')throw Error('private SMTP provider required');
if (!provider&&process.env.CTA_SMTP_LAB !== '1') throw Error('CTA SMTP laboratory explicitly disabled');
if(!provider&&process.env.GATEWAY_MODE==='OPERATIONAL')throw Error('laboratory configuration forbidden operationally');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const port = Number(process.env.CTA_SMTP_LAB_PORT);
if (!provider&&(!Number.isInteger(port) || port < 1 || port > 65535)) throw Error('invalid local SMTP port');
if(process.env.PROJECT_ID&&!/^[a-zA-Z0-9_-]{1,64}$/.test(process.env.PROJECT_ID))throw Error('invalid worker project');
const db = new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:2000,statement_timeout:3000,query_timeout:4000});
if(provider){try{await db.query('SELECT alert_id FROM cta_delivery_attempts LIMIT 0');await db.query('SELECT episode_id FROM health_delivery_attempts LIMIT 0');}catch{await db.end();throw Error('notification schema 057 required');}}
const stop = new AbortController();
const monitor=provider&&process.env.MONITOR_LOCAL_GATEWAY==='1'?localGatewayMonitor(db,process.env,Date.now,stop.signal):undefined;
const retryAfter=new Map<string,number>();
const shutdown=()=>{if(!stop.signal.aborted){stop.abort();process.stderr.write('notification worker stopping; current admission may finish\n');}};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  while (!stop.signal.aborted) {
    try {
      if(provider){
        if(monitor)try{await monitor();}catch{process.stderr.write('local gateway monitor unavailable\n');}
        let after='';
        sweep:for(;;){
          if(stop.signal.aborted)break;
          const projects=await db.query("SELECT id FROM projects WHERE id>$1 AND ($2::text IS NULL OR id=$2) AND lifecycle_state='ACTIVE' AND deleted_at IS NULL ORDER BY id LIMIT 25",[after,process.env.PROJECT_ID??null]);
          if(!projects.rowCount)break;
          for(const {id} of projects.rows){
            after=id;
            const jobs:[string,()=>Promise<unknown>][]=[['CLONE',()=>deliverOne(db,id,provider)],['CTA',()=>deliverProviderCta(db,id,provider)],['HEALTH',()=>deliverHealth(db,id,provider,()=>true,true)]];
            for(const [queue,send] of jobs){
              if(stop.signal.aborted)break sweep;
              const key=id+':'+queue;if(Date.now()<(retryAfter.get(key)??0))continue;
              try{await send();retryAfter.delete(key);}catch{
                if(retryAfter.size>=3000)retryAfter.delete(retryAfter.keys().next().value!);
                retryAfter.set(key,Date.now()+60000);process.stderr.write('notification '+queue+' maintenance failed; retry after 60s\n');
              }
            }
          }
        }
      }else await deliverCtaAlert(db, id => sendLocalCtaAlert(id, port));
    } catch { process.stderr.write('notification worker maintenance failed\n'); }
    try { await delay(1000, undefined, {signal:stop.signal}); } catch { /* shutdown */ }
  }
} finally { await db.end(); }
