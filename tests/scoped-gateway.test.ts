import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';

test('scoped browser observations isolate projects on one origin and preserve copied installation', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='scoped_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const health=randomUUID(), finance=randomUUID();
  const fixture=createServer((req,res) => {
    const id=req.url==='/financas' ? finance : health;
    res.writeHead(200,{'content-type':'text/html'}).end(`<div data-anticlone-surface="main"><a data-anticlone-point="shared01" href="/checkout">Checkout</a></div><script src="http://127.0.0.1:3000/i/${id}/runtime.js"></script><script src="http://127.0.0.1:3000/i/${id}/fallback.js"></script>`);
  }).listen(0,'127.0.0.1');
  await once(fixture,'listening');
  const address=fixture.address(); assert.ok(address && typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','023_cta_commercial','018_notification_budget','019_alert_outbox_expiry','025_installation_signals','036_cta_surface_policies']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query(await readFile('infra/037_protected_pages.sql','utf8'));
    await db.query(await readFile('infra/038_page_url_review.sql','utf8'));
    await db.query(await readFile('infra/039_page_policy_bindings.sql','utf8'));
    await db.query("INSERT INTO projects VALUES ('health','Health',$1),('finance','Finance',$1)",[origin]);
    const hp=randomUUID(), fp=randomUUID();
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES ($1,'health',$2,'Health'),($3,'finance',$4,'Finance')",[hp,health,fp,finance]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES ($1,$3,'/saude'),($2,$3,'/financas')",[hp,fp,origin]);
    const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
    for (const [project,path] of [['health','/saude'],['finance','/financas']]) {
      const point=randomUUID(), destination=randomUUID();
      await db.query('INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES($1,1,true,$2,$3,$4)',[project,'main',path,allocation]);
      await db.query("INSERT INTO active_cta_surface_policies VALUES($1,'main',1)",[project]);
      await db.query("INSERT INTO page_cta_policy_bindings(project_id,page_id,surface,version) VALUES($1,$2,'main',1)",[project,project==='health' ? hp : fp]);
      await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES($1,$2,'main','shared01','a','offer')",[project,point]);
      await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES($1,'offer',$2,$3)",[project,destination,origin+'/'+project+'-checkout']);
      await db.query("INSERT INTO cta_mappings VALUES($1,$2,'offer',$3)",[project,point,destination]);
    }
    // Synthetic fixture only; administrative review is implemented separately.
    await db.query('UPDATE protected_pages SET url_review_required=false WHERE id=ANY($1::uuid[])',[[hp,fp]]);
    const env: NodeJS.ProcessEnv={...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,SMTP_PORT:'1',PORT:'3000',SCOPED_LAB_INSTALLATION:health,SCOPED_LAB_ORIGIN:`http://localhost:${address.port}`};
    delete env.PROJECT_ID; delete env.ALLOWED_ORIGIN;
    child=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:'ignore'});
    for (let i=0;i<100;i++) { try { if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break; } catch { /* starting */ } await new Promise(r=>setTimeout(r,50)); }
    browser=await chromium.launch();
    const page=await browser.newPage();
    await page.addInitScript(()=>{const add=document.addEventListener.bind(document);document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{add(type,listener,options);if(type==='click')document.documentElement.dataset.ctaReady='yes';}) as typeof document.addEventListener;});
    for (const path of ['/saude','/financas']) {
      const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
      await page.goto(origin+path); assert.equal((await response).status(),204);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0);
    const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
    const browserDecision=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(`http://localhost:${address.port}/outro-slug`); assert.equal((await response).status(),204); await browserDecision;
    await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    const clicked=await page.evaluate(()=>{const link=document.querySelector<HTMLAnchorElement>('a')!;let target='';window.addEventListener('click',event=>{target=link.href;event.preventDefault();},{once:true});link.click();return target;});
    assert.equal(clicked,origin+'/health-checkout');
    const incidents=await db.query('SELECT project_id,host FROM incidents ORDER BY project_id');
    assert.deepEqual(incidents.rows,[{project_id:'health',host:'localhost'}]);
    const decide=(id:string,source:string) => fetch(`http://127.0.0.1:3000/i/${id}/entry-decision`,{method:'POST',headers:{origin:source,'content-type':'text/plain'},body:JSON.stringify({pathname:'/outro-slug',session:'a'.repeat(32),signals:{}})});
    const decision=await decide(health,`http://localhost:${address.port}`);
    const selected=await decision.json() as {action:string;pathname:string;mappings:{destination:string}[]};
    assert.equal(selected.action,'REPLACE_CONVERSION'); assert.equal(selected.pathname,'/outro-slug');
    assert.equal(selected.mappings[0].destination,origin+'/health-checkout');
    assert.deepEqual(await (await decide(finance,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    assert.deepEqual(await (await decide(health,origin)).json(),{action:'OBSERVE_ONLY'});
    await db.query("DELETE FROM page_cta_policy_bindings WHERE project_id='health'");
    assert.deepEqual(await (await decide(health,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    await db.query("INSERT INTO page_cta_policy_bindings VALUES('health',$1,'main',1)",[hp]);
    const generation=await db.query('SELECT url_generation FROM protected_pages WHERE id=$1',[hp]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,'https://new.test','/oferta')",[hp]);
    const changed=await db.query('SELECT url_generation,url_review_required FROM protected_pages WHERE id=$1',[hp]);
    assert.equal(BigInt(changed.rows[0].url_generation),BigInt(generation.rows[0].url_generation)+1n); assert.equal(changed.rows[0].url_review_required,true);
    assert.deepEqual(await (await decide(health,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    await assert.rejects(db.query("INSERT INTO page_cta_policy_bindings VALUES('finance',$1,'other',1)",[hp]),{code:'23503'});
    assert.equal((await fetch(`http://127.0.0.1:3000/i/${health}/observe`,{method:'POST',headers:{'content-type':'text/plain',origin},body:JSON.stringify({origin,pathname:'/saude',signals:{},project_id:'finance'})})).status,400);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await once(child,'exit'); }
    fixture.close(); await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
