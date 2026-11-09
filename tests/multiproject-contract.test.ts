import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { scopedGateway } from '../apps/scoped-gateway.js';
import { projectCheckoutWebhooks, checkoutMetrics } from '../apps/checkout-webhook.js';
import { projectMaintenance } from '../apps/project-maintenance.js';
import { managePages } from '../apps/protected-pages.js';
import { saveDraft, activatePolicy } from '../apps/protection-policy.js';
import { enableInstallation } from '../apps/installation.js';
import { observe } from '../apps/detection.js';
import { evaluateInactivity, configureHealth } from '../apps/health-alerts.js';

test('multiproject contract: independent entry pages, authenticated checkout and isolated maintenance failures', {timeout:60000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='contract_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const previous={...process.env};
  const original='http://127.0.0.1:18881';
  const fixture=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<p>Controlled clone</p>')).listen(0,'127.0.0.1');
  await once(fixture,'listening');
  const clone='http://localhost:'+(fixture.address() as AddressInfo).port;
  const ids=[randomUUID(),randomUUID(),randomUUID()], pages=[randomUUID(),randomUUID(),randomUUID()];
  const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let server:ReturnType<typeof createServer>|undefined;
  let child:ChildProcess|undefined;
  try {
    for (const file of (await readdir('infra')).filter(f=>/^\d{3}_.+\.sql$/.test(f)).sort()) await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects VALUES('health','Saúde',$1),('finance','Finanças',$1)",[original]);
    for (let i=0;i<3;i++) {
      await db.query('INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,$2,$3,$4)',[pages[i],i===2?'finance':'health',ids[i],'LP '+i]);
      await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[pages[i],original,'/lp'+i]);
    }
    for (const [version,path] of [[1,'/destination-a'],[2,'/destination-b']] as const) {
      await saveDraft(db,'health',{enabled:true,stealth:true,approved_destination:original+path,allocation});
      assert.equal(await activatePolicy(db,'health'),version);
    }
    const point=randomUUID(),destination=randomUUID();
    await db.query("INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES('health',1,true,'lp1','/lp1',$1)",[allocation]);
    await db.query("INSERT INTO active_cta_surface_policies VALUES('health','lp1',1)");
    await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('health',$1,'lp1','marker01','a','offer')",[point]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES('health','offer',$1,$2)",[destination,original+'/cta']);
    await db.query("INSERT INTO cta_mappings VALUES('health',$1,'offer',$2)",[point,destination]);
    const approve=async(index:number,version:number)=>{
      const state=await managePages(db,{action:'inspect',project:'health',page:pages[index]}) as {page:{url_generation:string;config_generation:string}};
      await managePages(db,{action:'approve',project:'health',page:pages[index],generation:state.page.url_generation,configGeneration:state.page.config_generation,entryVersion:version,ctaVersions:index===1 ? [1] : []});
    };
    await approve(0,1); await approve(1,2);
    process.env.SCOPED_LAB_INSTALLATIONS=ids.slice(0,2).join(','); process.env.SCOPED_LAB_ORIGIN=clone;
    delete process.env.SCOPED_LAB_INSTALLATION;
    const maintain=projectMaintenance(db,{SMTP_PORT:'1'});
    const gateway=scopedGateway(db,{},maintain.collect);
    const secretA='ab'.repeat(32),secretB='cd'.repeat(32);
    const checkout=projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'sender-a',secret:secretA},{project:'finance',route:'sender-b',secret:secretB}])});
    assert.throws(()=>projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'a',secret:secretA},{project:'finance',route:'b',secret:secretA}])}));
    assert.throws(()=>projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'a',secret:secretA},{project:'finance',route:'b',secret:secretA+'00'}])}),'zero-padded HMAC keys cannot cross projects');
    assert.throws(()=>projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_SECRET:secretA,CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'finance',route:'b',secret:secretA+'00'}])}));
    assert.throws(()=>projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'a',secret:secretA+'f'}])}));
    server=createServer((req,res)=>{if(!checkout(req,res)&&!gateway(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');
    await once(server,'listening');
    const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    browser=await chromium.launch(); const tab=await browser.newPage();
    await tab.goto(clone+'/copy');
    const decide=async(i:number)=>tab.evaluate(async({url})=>{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({pathname:'/copy',session:'a'.repeat(32),signals:{}})});return response.json();
    },{url:base+'/i/'+ids[i]+'/entry-decision'});
    assert.equal((await decide(0)).destination,original+'/destination-a');
    assert.equal((await decide(1)).destination,original+'/destination-b');
    assert.equal((await decide(1)).action,'PAGE_REDIRECT','entry redirect takes precedence over the approved CTA');
    assert.deepEqual(await decide(2),{action:'OBSERVE_ONLY'});
    const observePage=async(i:number)=>tab.evaluate(async({url,origin})=>{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({origin,pathname:'/copy',signals:{}})}); return response.status;
    },{url:base+'/i/'+ids[i]+'/observe',origin:clone});
    await managePages(db,{project:'health',action:'pause-project'});
    const before=(await db.query("SELECT count(*)::int n FROM incidents WHERE project_id='health'")).rows[0].n;
    assert.deepEqual(await decide(0),{action:'OBSERVE_ONLY'});
    assert.equal(await observePage(0),204);
    assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE project_id='health'")).rows[0].n,before);
    assert.equal(await observePage(2),204);
    assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE project_id='finance'")).rows[0].n,1);
    await managePages(db,{project:'health',action:'resume-project'});
    assert.equal((await decide(0)).destination,original+'/destination-a');
    await managePages(db,{project:'health',page:pages[0],action:'pause-page'});
    assert.deepEqual(await decide(0),{action:'OBSERVE_ONLY'});
    assert.equal((await decide(1)).destination,original+'/destination-b');
    await managePages(db,{project:'health',page:pages[0],action:'resume-page'});
    assert.equal((await decide(0)).destination,original+'/destination-a');
    // Legacy activation no longer changes either page's reviewed active binding.
    await activatePolicy(db,'health',1);
    assert.equal((await decide(1)).destination,original+'/destination-b');
    await managePages(db,{action:'add-url',project:'health',page:pages[0],url:original+'/migrated'});
    assert.deepEqual(await decide(0),{action:'OBSERVE_ONLY'});
    assert.equal((await decide(1)).destination,original+'/destination-b');
    await managePages(db,{action:'remove-url',project:'health',page:pages[0],url:original+'/lp0'});
    await approve(0,1);
    assert.equal((await decide(0)).destination,original+'/destination-a');
    const send=async(route:string,key:string,amount=100,endpoint=base+'/checkout-webhook/'+route)=>{
      const body=JSON.stringify({event_id:'same-event',sale_id:'same-sale',amount_minor:amount,currency:'BRL',occurred_at:'2026-11-09T00:00:00.000Z'}),ts=String(Math.floor(Date.now()/1000));
      return fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':ts,'x-checkout-signature':createHmac('sha256',Buffer.from(key,'hex')).update(ts+'.'+body).digest('hex')},body});
    };
    assert.equal((await send('sender-b',secretA)).status,401);
    assert.equal((await send('sender-a',secretA)).status,200);
    assert.deepEqual((await checkoutMetrics(db,'finance')).currencies,[]);
    assert.equal((await send('sender-b',secretB,200)).status,200);
    assert.equal((await (await send('sender-a',secretA)).json()).duplicate,true);
    assert.equal((await checkoutMetrics(db,'health')).currencies[0].reported_amount_minor,'100');
    assert.equal((await checkoutMetrics(db,'finance')).currencies[0].reported_amount_minor,'200');
    for(const id of ['finance','health']) {
      await enableInstallation(db,id);
      await observe(db,id,[],clone,'core',{});
      await db.query("INSERT INTO canary_observations(project_id,host,day,source,observed_at) VALUES($1,'old',current_date-8,'html_canary',now()-interval '8 days')",[id]);
    }
    await db.query(`CREATE FUNCTION reject_health_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='health' THEN RAISE EXCEPTION 'controlled claim failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER controlled_claim_failure BEFORE INSERT ON installation_signals FOR EACH ROW EXECUTE FUNCTION reject_health_claim()`);
    assert.equal(await maintain.collect('health',pages[0],original,'core'),false);
    assert.equal(await maintain.collect('finance',pages[2],original,'core'),true);
    assert.equal(await maintain.collect('health',pages[0],original,'core'),false,'one project backoff must not be reported as recovery');
    await db.query('DROP TRIGGER controlled_claim_failure ON installation_signals');
    // Core receipt never fabricates independent activity or an inactivity alert.
    await configureHealth(db,'finance',true,60,false);
    await db.query("UPDATE installation_last_signal SET first_observed_at=now()-interval '5 minutes',last_observed_at=now()-interval '2 minutes' WHERE project_id='finance'");
    assert.equal((await db.query("SELECT last_activity_at FROM installation_last_signal WHERE project_id='finance'")).rows[0].last_activity_at,null);
    await evaluateInactivity(db,'finance');
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE kind='INACTIVE'")).rows[0].n,0);
    for(const [project,page] of [['health',pages[0]],['finance',pages[2]]]) await db.query("INSERT INTO page_installation_signals(project_id,page_id,source,last_observed_at) VALUES($1,$2,'fallback',now()-interval '8 days')",[project,page]);
    // Fail the first project in catalog order; the second still retains/delivers.
    await db.query(`CREATE FUNCTION reject_finance_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.project_id='finance' THEN RAISE EXCEPTION 'controlled cleanup failure'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER controlled_failure BEFORE DELETE ON canary_observations FOR EACH ROW EXECUTE FUNCTION reject_finance_cleanup()`);
    await Promise.all([maintain(),maintain()]);
    assert.deepEqual((await db.query('SELECT project_id FROM canary_observations ORDER BY project_id')).rows,[{project_id:'finance'}]);
    assert.equal((await db.query("SELECT count(*)::int n FROM page_installation_signals WHERE source='fallback'")).rows[0].n,0);
    const attempts=await db.query('SELECT i.project_id,a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id ORDER BY i.project_id');
    assert.deepEqual(attempts.rows,[{project_id:'finance',attempts:0},{project_id:'health',attempts:1}]);
    assert.deepEqual((await db.query("SELECT project_id,source FROM health_episodes WHERE source='maintenance'")).rows,[{project_id:'finance',source:'maintenance'}]);
    await db.query('DROP TRIGGER controlled_failure ON canary_observations');
    await maintain();
    assert.equal((await db.query('SELECT count(*)::int n FROM canary_observations')).rows[0].n,0);
    assert.equal((await db.query("SELECT recovered_at IS NOT NULL AS recovered FROM health_episodes WHERE project_id='finance' AND source='maintenance'")).rows[0].recovered,true);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='health' AND source='maintenance'")).rows[0].n,0);
    // Same gateway process accepts old scripts/webhooks and scoped installations.
    const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,PROJECT_ID:'health',SMTP_PORT:'1',PORT:'3000',CHECKOUT_WEBHOOK_SECRET:secretA};
    child=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:'ignore'});
    let ready=false;
    for(let i=0;i<100;i++) { try { if((await fetch('http://127.0.0.1:3000/healthz')).ok) {ready=true;break;} } catch { /* startup */ } await new Promise(r=>setTimeout(r,50)); }
    assert.equal(ready,true);
    assert.equal((await fetch('http://127.0.0.1:3000/runtime.js')).status,200);
    assert.equal((await (await send('',secretA,100,'http://127.0.0.1:3000/checkout-webhook')).json()).duplicate,true,'legacy endpoint retains the same event identity');
    assert.equal((await fetch('http://127.0.0.1:3000/observe',{method:'POST',headers:{origin:original,'content-type':'text/plain'},body:original})).status,204);
    assert.equal((await fetch('http://127.0.0.1:3000/i/'+ids[2]+'/observe',{method:'POST',headers:{origin:original,'content-type':'text/plain'},body:JSON.stringify({origin:original,pathname:'/lp2',signals:{}})})).status,204);
    const signal=await managePages(db,{action:'inspect',project:'finance',page:pages[2]}) as {signals:{source:string}[]};
    assert.equal(signal.signals[0].source,'core');
    for(const project of ['health','finance']) await db.query("INSERT INTO canary_observations(project_id,host,day,source,observed_at) VALUES($1,'coexist',current_date-8,'html_canary',now()-interval '8 days')",[project]);
    let retained=true;
    for(let i=0;i<100;i++) { retained=(await db.query("SELECT count(*)::int n FROM canary_observations WHERE host='coexist'")).rows[0].n>0; if(!retained)break; await new Promise(r=>setTimeout(r,50)); }
    assert.equal(retained,false,'legacy and scoped projects both receive maintenance');
    child.kill(); await once(child,'exit'); child=undefined;
    const scopedEnv:{[key:string]:string|undefined}={...env}; delete scopedEnv.PROJECT_ID;
    child=spawn(process.execPath,['dist/apps/server.js'],{env:scopedEnv,stdio:'ignore'});
    ready=false;
    for(let i=0;i<100;i++) { try { if((await fetch('http://127.0.0.1:3000/healthz')).ok) {ready=true;break;} } catch { /* startup */ } await new Promise(r=>setTimeout(r,50)); }
    assert.equal(ready,true);
    assert.equal((await fetch('http://127.0.0.1:3000/observe',{method:'POST',headers:{origin:original,'content-type':'text/plain'},body:original})).status,404);
    assert.equal((await fetch('http://127.0.0.1:3000/i/'+ids[2]+'/observe',{method:'POST',headers:{origin:original,'content-type':'text/plain'},body:JSON.stringify({origin:original,pathname:'/lp2',signals:{}})})).status,204);
    assert.equal((await db.query('SELECT installation_id FROM protected_pages WHERE id=$1',[pages[2]])).rows[0].installation_id,ids[2]);
    assert.equal((await checkoutMetrics(db,'health')).currencies[0].reported_amount_minor,'100');
    assert.equal((await checkoutMetrics(db,'finance')).currencies[0].reported_amount_minor,'200');
  } finally {
    if(child && child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit');}
    process.env=previous;
    fixture.close(); await once(fixture,'close');
    await browser?.close(); if(server){server.close();await once(server,'close');}
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
