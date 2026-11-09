import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
    const approve=async(index:number,version:number)=>{
      const state=await managePages(db,{action:'inspect',project:'health',page:pages[index]}) as {page:{url_generation:string;config_generation:string}};
      await managePages(db,{action:'approve',project:'health',page:pages[index],generation:state.page.url_generation,configGeneration:state.page.config_generation,entryVersion:version,ctaVersions:[]});
    };
    await approve(0,1); await approve(1,2);
    process.env.SCOPED_LAB_INSTALLATIONS=ids.slice(0,2).join(','); process.env.SCOPED_LAB_ORIGIN=clone;
    delete process.env.SCOPED_LAB_INSTALLATION;
    const gateway=scopedGateway(db,{});
    const secretA='ab'.repeat(32),secretB='cd'.repeat(32);
    const checkout=projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'sender-a',secret:secretA},{project:'finance',route:'sender-b',secret:secretB}])});
    assert.throws(()=>projectCheckoutWebhooks(db,{CHECKOUT_WEBHOOK_ROUTES:JSON.stringify([{project:'health',route:'a',secret:secretA},{project:'finance',route:'b',secret:secretA}])}));
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
    assert.deepEqual(await decide(2),{action:'OBSERVE_ONLY'});
    // Legacy activation no longer changes either page's reviewed active binding.
    await activatePolicy(db,'health',1);
    assert.equal((await decide(1)).destination,original+'/destination-b');
    await managePages(db,{action:'add-url',project:'health',page:pages[0],url:original+'/migrated'});
    assert.deepEqual(await decide(0),{action:'OBSERVE_ONLY'});
    assert.equal((await decide(1)).destination,original+'/destination-b');
    await managePages(db,{action:'remove-url',project:'health',page:pages[0],url:original+'/lp0'});
    await approve(0,1);
    assert.equal((await decide(0)).destination,original+'/destination-a');
    const send=async(route:string,key:string,amount=100)=>{
      const body=JSON.stringify({event_id:'same-event',sale_id:'same-sale',amount_minor:amount,currency:'BRL',occurred_at:'2026-11-09T00:00:00.000Z'}),ts=String(Math.floor(Date.now()/1000));
      return fetch(base+'/checkout-webhook/'+route,{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':ts,'x-checkout-signature':createHmac('sha256',Buffer.from(key,'hex')).update(ts+'.'+body).digest('hex')},body});
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
    // Fail the first project in catalog order; the second still retains/delivers.
    await db.query(`CREATE FUNCTION reject_finance_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.project_id='finance' THEN RAISE EXCEPTION 'controlled cleanup failure'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER controlled_failure BEFORE DELETE ON canary_observations FOR EACH ROW EXECUTE FUNCTION reject_finance_cleanup()`);
    const maintain=projectMaintenance(db,{SMTP_PORT:'1'});
    await Promise.all([maintain(),maintain()]);
    assert.deepEqual((await db.query('SELECT project_id FROM canary_observations ORDER BY project_id')).rows,[{project_id:'finance'}]);
    const attempts=await db.query('SELECT i.project_id,a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id ORDER BY i.project_id');
    assert.deepEqual(attempts.rows,[{project_id:'finance',attempts:0},{project_id:'health',attempts:1}]);
    assert.deepEqual((await db.query("SELECT project_id,source FROM health_episodes WHERE source='maintenance'")).rows,[{project_id:'finance',source:'maintenance'}]);
    await db.query('DROP TRIGGER controlled_failure ON canary_observations');
    await maintain();
    assert.equal((await db.query('SELECT count(*)::int n FROM canary_observations')).rows[0].n,0);
    assert.equal((await db.query("SELECT recovered_at IS NOT NULL AS recovered FROM health_episodes WHERE project_id='finance' AND source='maintenance'")).rows[0].recovered,true);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='health' AND source='maintenance'")).rows[0].n,0);
  } finally {
    process.env=previous;
    fixture.close(); await once(fixture,'close');
    await browser?.close(); if(server){server.close();await once(server,'close');}
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
