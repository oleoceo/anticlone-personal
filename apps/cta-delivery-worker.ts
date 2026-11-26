import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { deliverCtaAlert } from './cta-delivery.js';
import { sendLocalCtaAlert } from './cta-local-smtp.js';
import {deliverProviderCta} from './cta-delivery.js';
import {providerMatchesSettings,smtpProvider} from './smtp-provider.js';
import {currentSmtpProvider} from './panel-smtp.js';
import {deliverOne} from './alerts.js';
import {deliverHealth} from './health-alerts.js';
import {reportNotificationWorker} from './notification-worker-status.js';
import {localGatewayMonitor} from './local-gateway-monitor.js';

const configuredProvider=smtpProvider(process.env);
const providerMode=!!configuredProvider || !!process.env.SMTP_PANEL_KEY;
if(!providerMode&&process.env.NOTIFICATION_WORKER_MODE==='PROVIDER')throw Error('private SMTP provider required');
if (!providerMode&&process.env.CTA_SMTP_LAB !== '1') throw Error('CTA SMTP laboratory explicitly disabled');
if(!providerMode&&process.env.GATEWAY_MODE==='OPERATIONAL')throw Error('laboratory configuration forbidden operationally');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const port = Number(process.env.CTA_SMTP_LAB_PORT);
if (!providerMode&&(!Number.isInteger(port) || port < 1 || port > 65535)) throw Error('invalid local SMTP port');
if(process.env.PROJECT_ID&&!/^[a-zA-Z0-9_-]{1,64}$/.test(process.env.PROJECT_ID))throw Error('invalid worker project');
const db = new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:2000,statement_timeout:3000,query_timeout:4000});
if(providerMode){try{await db.query('SELECT alert_id FROM cta_delivery_attempts LIMIT 0');await db.query('SELECT episode_id FROM health_delivery_attempts LIMIT 0');}catch{await db.end();throw Error('notification schema 057 required');}}
const stop = new AbortController();
const monitor=providerMode&&process.env.MONITOR_LOCAL_GATEWAY==='1'?localGatewayMonitor(db,process.env,Date.now,stop.signal):undefined;
const retryAfter=new Map<string,number>();
const statusPath=process.env.NOTIFICATION_WORKER_STATUS_PATH;
const report=(state:Parameters<typeof reportNotificationWorker>[1], version: number | null = null)=>
  reportNotificationWorker(statusPath,state,!!process.env.PROJECT_ID,version).catch(()=>process.stderr.write('notification worker status unavailable\n'));
const shutdown=()=>{if(!stop.signal.aborted){stop.abort();process.stderr.write('notification worker stopping; current admission may finish\n');}};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  while (!stop.signal.aborted) {
    try {
      if(providerMode){
        if(monitor)try{await monitor();}catch{process.stderr.write('local gateway monitor unavailable\n');}
        const provider=await currentSmtpProvider(db, configuredProvider);
        const settings=statusPath ? (await db.query(`SELECT version,provider,host,port,tls_mode,sender,recipient,
          CASE WHEN to_jsonb(notification_settings)->>'smtp_secret_encrypted' IS NOT NULL THEN true END AS smtp_secret_encrypted
          FROM notification_settings WHERE singleton=true`)).rows[0] : undefined;
        if (!provider || (statusPath && !providerMatchesSettings(provider,settings))) {
          await report('TRANSPORT_UNAVAILABLE');
          try { await delay(1000, undefined, {signal:stop.signal}); } catch { /* shutdown */ }
          continue;
        }
        let after='';
        sweep:for(;;){
          if(stop.signal.aborted)break;
          const projects=await db.query("SELECT id FROM projects WHERE id>$1 AND ($2::text IS NULL OR id=$2) AND lifecycle_state='ACTIVE' AND deleted_at IS NULL ORDER BY id LIMIT 25",[after,process.env.PROJECT_ID??null]);
          if(!projects.rowCount)break;
          for(const {id} of projects.rows){
            after=id;
            const jobs:[string,()=>Promise<unknown>][]=[['CLONE',()=>deliverOne(db,id,provider)],['CTA',()=>deliverProviderCta(db,id,provider)],['HEALTH',()=>deliverHealth(db,id,provider,()=>true,process.env.NOTIFICATION_WORKER_OWNS_INACTIVITY!=='1')]];
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
        await report(retryAfter.size ? 'QUEUE_ERROR' : 'READY', settings?.version ?? null);
      }else await deliverCtaAlert(db, id => sendLocalCtaAlert(id, port));
    } catch {
      await report('QUEUE_ERROR');
      process.stderr.write('notification worker maintenance failed\n');
    }
    try { await delay(1000, undefined, {signal:stop.signal}); } catch { /* shutdown */ }
  }
} finally { await db.end(); }
