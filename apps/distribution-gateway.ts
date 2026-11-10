import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { readDistribution } from './runtime-distribution.js';
import { resolvePageContext } from './page-context.js';
import { configuredOrigin, recordCanaryClaim } from './detection.js';
import { operationallyEligible } from './operational-eligibility.js';
import { recordInstallationActivity } from './health-alerts.js';
import type { LayerObserver } from './runtime-layer-observations.js';

const allowed:Record<string,readonly string[]>={SCRIPT:['runtime.js','core.js','fallback.js'],TELEMETRY:['observe','observe/fallback','entry-decision','cta-refresh','observed-session','observed-action'],STATIC_ASSETS:['html.gif','css.gif','cta-inventory.js']};
// Dispatch through existing domain handlers; distribution never authorizes actions.
export function distributionGateway(db:Pool,scripts:Record<string,Buffer>,dispatch:(req:IncomingMessage,res:ServerResponse)=>void,layers:LayerObserver=async()=>{}) {
  let start=Date.now(),count=0;
  return (req:IncomingMessage,res:ServerResponse):boolean=>{
    if (!(req.url??'').startsWith('/d/')) return false;
    const match=/^\/d\/v1\/([a-f0-9-]{36})\/(runtime\.js|core\.js|fallback\.js|observe(?:\/fallback)?|entry-decision|cta-refresh|observed-session|observed-action|html\.gif|css\.gif|cta-inventory\.js)$/.exec(req.url??'');
    res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('X-Content-Type-Options','nosniff');
    if (Date.now()-start>=60000) {start=Date.now();count=0;}
    if (++count>1200) {res.writeHead(429).end();return true;}
    if (!match) {res.writeHead(404).end();return true;}
    void (async()=>{
      const installed=(await db.query("SELECT to_regclass('runtime_aliases') IS NOT NULL AS installed")).rows[0].installed;
      if (!installed) {res.writeHead(404).end();return;}
      const row=(await db.query('SELECT installation_id,version,role FROM runtime_aliases WHERE alias=$1',[match[1]])).rows[0];
      const endpoint=match[2];
      if (!row || !allowed[row.role]?.includes(endpoint)) {res.writeHead(404).end();return;}
      const distribution=await readDistribution(db,row.installation_id,row.version);
      if (!distribution) {res.writeHead(503).end();return;}
      if (scripts[endpoint]) {
        if (req.method!=='GET') {res.writeHead(405).end();return;}
        const content=scripts[endpoint].toString('utf8').replace('const distribution = null;',()=>`const distribution = ${JSON.stringify(distribution)};`);
        res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'}).end(content);return;
      }
      if (endpoint==='html.gif'||endpoint==='css.gif') {
        if (req.method!=='GET') {res.writeHead(405).end();return;}
        const context=await resolvePageContext(db,row.installation_id);
        if (!context) {res.writeHead(404).end();return;}
        const source=endpoint==='html.gif'?'html_canary':'css_canary';
        let claimedOrigin:string|undefined;
        try{claimedOrigin=configuredOrigin(new URL(req.headers.referer??'').origin);}catch{ /* Unknown. */ }
        const client=await db.connect().catch(error=>{if(claimedOrigin)void layers(context,claimedOrigin,source,true).catch(()=>{});throw error;});
        try {
          await client.query('BEGIN');
          if (await operationallyEligible(client,context.project,context.page,true)) {
            await recordCanaryClaim(client,context.project,req.headers.referer,source);
            let origin:string|undefined;
            try {origin=configuredOrigin(new URL(req.headers.referer??'').origin);} catch { /* Unknown remains unknown. */ }
            if (origin && context.urls.some(url=>url.origin===origin)) {
              await client.query(`INSERT INTO page_installation_signals(project_id,page_id,source) VALUES($1,$2,$3) ON CONFLICT(project_id,page_id,source) DO UPDATE SET last_observed_at=clock_timestamp() WHERE page_installation_signals.last_observed_at<clock_timestamp()-interval '1 minute'`,[context.project,context.page,source]);
              const health=(await client.query("SELECT to_regclass('installation_last_signal') IS NOT NULL AS installed")).rows[0].installed;
              if(health) await recordInstallationActivity(client,context.project,origin);
            }
          }
          await client.query('COMMIT');
        } catch(error) {await client.query('ROLLBACK');if(claimedOrigin)void layers(context,claimedOrigin,source,true).catch(()=>{});throw error;} finally {client.release();}
        res.writeHead(200,{'Content-Type':'image/gif'}).end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));
        if(claimedOrigin)void layers(context,claimedOrigin,source).catch(()=>{});
        return;
      }
      req.url='/i/'+row.installation_id+'/'+endpoint;
      dispatch(req,res);
    })().catch(()=>{if(!res.headersSent)res.writeHead(503).end();});
    return true;
  };
}
