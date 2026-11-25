import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { readDistribution } from './runtime-distribution.js';
import {assetFileContract, assetFilePatterns, distributionPaths, distributionRoleByResource} from './distribution-paths.js';
import { resolvePageContext } from './page-context.js';
import { configuredOrigin, recordCanaryClaim } from './detection.js';
import { operationallyEligible } from './operational-eligibility.js';
import { recordInstallationActivity } from './health-alerts.js';
import type { LayerObserver } from './runtime-layer-observations.js';
import {receiveRuntimeReceipt,receiveDistributionScript,receiptAliases} from './investigation-receipts.js';

// Dispatch through existing domain handlers; distribution never authorizes actions.
export function distributionGateway(db:Pool,scripts:Record<string,Buffer>,dispatch:(req:IncomingMessage,res:ServerResponse)=>void,layers:LayerObserver=async()=>{}) {
  let start=Date.now(),count=0;
  return (req:IncomingMessage,res:ServerResponse):boolean=>{
    const path = req.url ?? '';
    const compact = path.startsWith('/assets/');
    if (!compact && !path.startsWith('/d/') && !path.startsWith('/r/')) return false;
    const assetFile = /^\/assets\/((?:js|img|api)\/[a-z]+)\.([0-9a-f]{20})(\.(?:js|gif))?$/.exec(path);
    const match = compact
      ? /^\/assets\/([A-Za-z0-9_-]{22})\/([a-z.-]+)$/.exec(path)
      : /^\/(?:d\/v1|r\/v2)\/([a-f0-9-]{36})\/([a-z.-]+(?:\/fallback)?)$/.exec(path);
    res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('X-Content-Type-Options','nosniff');
    if (Date.now()-start>=60000) {start=Date.now();count=0;}
    if (++count>1200) {res.writeHead(429).end();return true;}
    if (!assetFile && !match) {res.writeHead(404).end();return true;}
    const token = assetFile?.[2] ?? match![1];
    void (async()=>{
      const routeStarted = performance.now();
      const row=(await db.query(`SELECT a.alias,a.installation_id,a.version,a.role,d.contract_version, to_jsonb(a)->>'public_token' AS public_token,
        (SELECT count(*)::int FROM runtime_aliases WHERE installation_id=a.installation_id AND version=a.version) AS aliases
        FROM runtime_aliases a JOIN runtime_distributions d USING(installation_id,version) WHERE ${compact ? 'a.public_token' : 'a.alias'}=$1`,[token])).rows[0];
      if (!row || Boolean(row.public_token)!==compact || Boolean(assetFile)!==(row.contract_version===assetFileContract) ||
        (!compact && (row.contract_version===2 ? !path.startsWith('/r/v2/') : row.contract_version!==1 || !path.startsWith('/d/v1/')))) {
        res.writeHead(404).end();return;
      }
      const paths = distributionPaths(row.contract_version);
      const endpoint = assetFile
        ? Object.keys(assetFilePatterns).find(name=>assetFilePatterns[name]===assetFile[1]+'.*'+(assetFile[3] ?? ''))
        : paths ? Object.keys(paths).find(name=>paths[name]===match![2]) : match![2];
      if (!endpoint || distributionRoleByResource[endpoint]!==row.role) {res.writeHead(404).end();return;}
      if (row.aliases!==3) {res.writeHead(503).end();return;}
      if (scripts[endpoint]) {
        const distribution=await readDistribution(db,row.installation_id,row.version);
        if (!distribution) {res.writeHead(503).end();return;}
        if (req.method!=='GET') {res.writeHead(405).end();return;}
        const content=scripts[endpoint].toString('utf8').replace('const distribution = null;',()=>`const distribution = ${JSON.stringify(distribution)};`);
        receiveDistributionScript(db,row.installation_id,endpoint,row.alias);
        res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'}).end(content);return;
      }
      if (endpoint==='html.gif'||endpoint==='css.gif') {
        if (req.method!=='GET') {res.writeHead(405).end();return;}
        const context=await resolvePageContext(db,row.installation_id);
        if (!context) {res.writeHead(404).end();return;}
        const source=endpoint==='html.gif'?'html_canary':'css_canary';
        let claimedOrigin:string|undefined;
        try{claimedOrigin=configuredOrigin(new URL(req.headers.referer??'').origin);}catch{ /* Unknown. */ }
        receiveRuntimeReceipt(db,context,endpoint,source,claimedOrigin?new URL(claimedOrigin).hostname:undefined,row.alias);
        const client=await db.connect().catch(error=>{if(claimedOrigin)void layers(context,claimedOrigin,source,true).catch(()=>{});throw error;});
        try {
          await client.query('BEGIN');
          if (await operationallyEligible(client,context.project,context.page,true)) {
            await recordCanaryClaim(client,context.project,req.headers.referer,source);
            const activity=(await client.query("SELECT to_regclass('runtime_alias_activity') IS NOT NULL AS installed")).rows[0].installed;
            if(activity) await client.query(`INSERT INTO runtime_alias_activity(alias,source) VALUES($1,$2) ON CONFLICT(alias,source) DO UPDATE SET last_received_at=clock_timestamp() WHERE runtime_alias_activity.last_received_at<clock_timestamp()-interval '1 minute'`,[row.alias,source]);
            let origin:string|undefined;
            try {origin=configuredOrigin(new URL(req.headers.referer??'').origin);} catch { /* Unknown remains unknown. */ }
            // F45 is an origin-level aggregate, not LP integrity. Preserve that
            // unauthenticated activity claim without attributing a pathname.
            if (origin && context.urls.some(url=>url.origin===origin)) {
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
      if (endpoint==='entry-decision') res.setHeader('Server-Timing', `route;dur=${(performance.now()-routeStarted).toFixed(1)}`);
      receiptAliases.set(req,row.alias);
      req.url='/i/'+row.installation_id+'/'+endpoint;
      dispatch(req,res);
    })().catch((error:unknown)=>{if(!res.headersSent)res.writeHead((error as {code?:string}).code?.match(/^(42P01|42703)$/)?404:503).end();});
    return true;
  };
}
