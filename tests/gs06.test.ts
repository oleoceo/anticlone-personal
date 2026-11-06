import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { saveDraft, activatePolicy } from '../apps/protection-policy.js';
import { observe } from '../apps/detection.js';
import { classifyIncident } from '../apps/incident-triage.js';
import { collectInfrastructure, type DnsResolver } from '../apps/infrastructure-dns.js';

test('GS06 integration: persisted policy, controlled LOW and original', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='gs06_'+crypto.randomUUID().replaceAll('-',''); await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  await db.query(await readFile('infra/008_traffic_observations.sql', 'utf8'));
  await db.query(await readFile('infra/009_risk_assessments.sql', 'utf8'));
  await db.query(await readFile('infra/024_risk_evidence.sql', 'utf8'));
  for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','010_policy_allocation','018_notification_budget','019_alert_outbox_expiry']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  for (const file of ['030_infrastructure_dns','031_investigation_timeline','032_incident_status_audit']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  const project='gs06_'+crypto.randomUUID();
  const fixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url?.startsWith('/adversarial') ? '<a href="/next">Native</a><script src="http://127.0.0.1:3000/runtime.js"></script><script src="http://127.0.0.1:3000/fallback.js"></script><img src="http://127.0.0.1:3000/canary/html.gif">' : '<h1>site</h1><a href="/next">next</a><script src="http://127.0.0.1:3000/runtime.js"></script>'));
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening'); const address=fixture.address(); if (!address || typeof address==='string') throw Error('address');
  const original=`http://127.0.0.1:${address.port}`, clone=`http://localhost:${address.port}`;
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
  await db.query('INSERT INTO page_redirect_policies VALUES($1,1,true,$2)',[project,original+'/approved']);
  const start = (risk = 'LOW') => spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:options,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:risk},stdio:['ignore','ignore','inherit']});
  let app=start();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let ready=false; for(let n=0;n<100;n++){try { if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;} }catch {} await new Promise(r=>setTimeout(r,100));} assert.ok(ready);
    const decision = async () => (await (await fetch('http://127.0.0.1:3000/entry-decision',{method:'POST',headers:{origin:clone,'content-type':'text/plain'},body:JSON.stringify({session:'0123456789abcdef0123456789abcdef',signals:{}})})).json()) as {action:string};
    assert.equal((await decision()).action,'OBSERVE_ONLY');
    await saveDraft(db,project,{enabled:true,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}}); await activatePolicy(db,project);
    app.kill('SIGTERM'); await once(app,'exit'); app=start();
    let restarted=false; for(let n=0;n<100;n++){try { if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){restarted=true;break;} }catch {} await new Promise(r=>setTimeout(r,100));} assert.ok(restarted);
    assert.equal((await decision()).action,'PAGE_REDIRECT');
    await db.query("CREATE FUNCTION fail_timeline_gs06() RETURNS trigger LANGUAGE plpgsql AS $failure$ BEGIN IF NEW.event_type='risk_assessment' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END; $failure$");
    await db.query('CREATE TRIGGER fail_timeline_gs06 BEFORE INSERT ON investigation_timeline FOR EACH ROW EXECUTE FUNCTION fail_timeline_gs06()');
    await db.query("DELETE FROM investigation_timeline WHERE project_id=$1 AND event_type='risk_assessment'",[project]);
    try { assert.equal((await decision()).action,'PAGE_REDIRECT'); } finally { await db.query('DROP TRIGGER fail_timeline_gs06 ON investigation_timeline'); }
    const submit = async (body:object) => (await (await fetch('http://127.0.0.1:3000/entry-decision',{method:'POST',headers:{origin:clone,'content-type':'text/plain'},body:JSON.stringify(body)})).json()) as {action:string};
    assert.equal((await submit({signals:{}})).action,'OBSERVE_ONLY');
    assert.equal((await submit({session:'invalid',signals:{medium:'cpc'}})).action,'OBSERVE_ONLY');
    assert.equal((await submit({session:'0123456789abcdef0123456789abcdef',signals:{risk:'LOW'}})).action,'OBSERVE_ONLY');
    await db.query('ALTER TABLE risk_assessment_days RENAME TO unavailable_risk_assessments');
    try { assert.equal((await decision()).action,'OBSERVE_ONLY'); } finally { await db.query('ALTER TABLE unavailable_risk_assessments RENAME TO risk_assessment_days'); }
    await db.query('ALTER TABLE active_protection_policies RENAME TO unavailable_policies');
    try { assert.equal((await decision()).action,'OBSERVE_ONLY'); } finally { await db.query('ALTER TABLE unavailable_policies RENAME TO active_protection_policies'); }
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']}); const page=await browser.newPage();
    await page.goto(original+'/original'); await page.waitForTimeout(400); assert.equal(page.url(),original+'/original');
    await saveDraft(db,project,{enabled:true,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:0,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}}); await activatePolicy(db,project);
    const requests: {session:string; signals:object}[] = [];
    page.on('request', request => { if (request.url().endsWith('/entry-decision') && request.postData()) requests.push(JSON.parse(request.postData()!) as {session:string;signals:object}); });
    await page.goto(clone+'/clone?utm_medium=cpc&gclid=privatevalue'); await page.waitForTimeout(400);
    await page.goto(clone+'/clone'); await page.waitForTimeout(400);
    assert.equal(page.url(),clone+'/clone'); assert.ok(requests.length>=2);
    assert.equal(requests[0].session,requests[1].session); assert.deepEqual(requests[0].signals,requests[1].signals);
    assert.ok(!JSON.stringify(requests).includes('privatevalue'));
    await saveDraft(db,project,{enabled:true,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}}); await activatePolicy(db,project);
    await page.goto(clone+'/clone'); await page.waitForURL(original+'/approved'); await page.waitForTimeout(400); assert.equal(page.url(),original+'/approved');
    // Both cases consume a real decision at 100 ms of controlled runtime time.
    // The control proves eligibility; only the early interaction differs.
    for (const interact of [false,true]) {
      const context=await browser.newContext();
      const controlled=await context.newPage();
      await controlled.clock.install({time:0});
      await controlled.clock.pauseAt(1000);
      await controlled.addInitScript(({interact})=>{
        const state=window as typeof window & {gs06Start:number; gs06Consumed:Promise<void>};
        state.gs06Start=performance.now();
        let consumed:()=>void;
        state.gs06Consumed=new Promise<void>(resolve=>{ consumed=resolve; });
        const fetchOriginal=window.fetch.bind(window);
        window.fetch=async (...args)=>{
          if (!String(args[0]).endsWith('/entry-decision')) return fetchOriginal(...args);
          if (interact) dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
          const response=await fetchOriginal(...args);
          const jsonOriginal=response.json.bind(response);
          response.json=async ()=>{
            const decision=await jsonOriginal();
            // Drain the runtime's decision continuation before checking the page.
            queueMicrotask(()=>queueMicrotask(()=>consumed()));
            return decision;
          };
          return response;
        };
      },{interact});
      await controlled.route('**/entry-decision',async route=>{
        const response=await route.fetch();
        assert.equal((await response.json() as {action:string}).action,'PAGE_REDIRECT');
        await controlled.clock.runFor(100);
        assert.equal(await controlled.evaluate(()=>performance.now()-(window as typeof window & {gs06Start:number}).gs06Start),100);
        await route.fulfill({response});
      },{times:1});
      await controlled.goto(clone+'/clone');
      if (interact) {
        await controlled.evaluate(()=>(window as typeof window & {gs06Consumed:Promise<void>}).gs06Consumed);
        assert.equal(await controlled.evaluate(()=>performance.now()-(window as typeof window & {gs06Start:number}).gs06Start),100,'decision processed before the unchanged 150 ms deadline');
        assert.equal(controlled.url(),clone+'/clone');
        await controlled.unrouteAll({behavior:'wait'});
        // DOM click retains the anchor's native default navigation with time paused.
        await controlled.getByText('next',{exact:true}).evaluate((node:HTMLElement)=>node.click());
        await controlled.waitForURL(clone+'/next');
      } else {
        await controlled.waitForURL(original+'/approved');
      }
      await context.close();
    }
    // A valid redirect delivered after the entry deadline must leave native navigation usable.
    const timed=await browser.newPage();
    await timed.route('**/entry-decision',async route=>{
      const response=await route.fetch();
      assert.equal((await response.json() as {action:string}).action,'PAGE_REDIRECT');
      await new Promise(resolve=>setTimeout(resolve,250));
      await route.fulfill({response});
    });
    const timedResponse=timed.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await timed.goto(clone+'/clone'); await timedResponse;
    await timed.unrouteAll({behavior:'wait'});
    await timed.waitForTimeout(100);
    assert.equal(timed.url(),clone+'/clone');
    await timed.getByText('next',{exact:true}).click(); await timed.waitForURL(clone+'/next');
    await timed.close();
    let observed=false; for(let n=0;n<50;n++){if((await db.query('SELECT id FROM incidents WHERE project_id=$1',[project])).rowCount){observed=true;break;} await new Promise(r=>setTimeout(r,100));} assert.ok(observed);
    app.kill('SIGTERM'); await once(app,'exit'); app=start('');
    let uncertainReady=false; for(let n=0;n<100;n++){try { if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){uncertainReady=true;break;} }catch {} await new Promise(r=>setTimeout(r,100));} assert.ok(uncertainReady);
    await page.goto(clone+'/paid?utm_medium=cpc&gclid=abc&risk=LOW'); await page.waitForTimeout(500);
    assert.equal(page.url(),clone+'/paid?utm_medium=cpc&gclid=abc&risk=LOW');
    assert.equal((await decision()).action,'OBSERVE_ONLY');
    // An incident and infrastructure history are host aggregates, not evidence about this visit.
    const host='copy.owner-domain.com', claimed='https://'+host;
    await observe(db,project,original,claimed);
    const visit=async () => {
      for (const phase of ['entry-decision','cta-refresh']) {
        const response=await fetch('http://127.0.0.1:3000/'+phase,{method:'POST',headers:{origin:claimed,'content-type':'text/plain'},body:JSON.stringify({session:'b'.repeat(32),signals:{medium:'cpc'}})});
        assert.deepEqual(await response.json(),{action:'OBSERVE_ONLY'});
      }
      const rows=await db.query('SELECT level,source FROM risk_assessment_days WHERE project_id=$1 AND host=$2',[project,host]);
      assert.ok(rows.rowCount && rows.rows.every(row=>row.level==='UNCERTAIN' && row.source==='server_default'));
    };
    await visit();
    const id=(await db.query('SELECT id FROM incidents WHERE project_id=$1 AND host=$2',[project,host])).rows[0].id as string;
    const triage={project,host,incident_id:id,version:'0',expected:'unverified',status:'confirmed_copy',justification:'Controlled fixture'};
    await classifyIncident(db,triage); await visit();
    await classifyIncident(db,{...triage,version:'1',expected:'confirmed_copy',status:'false_positive'}); await visit();
    const resolver=(address:string):DnsResolver=>({resolve4:async()=>[address],resolve6:async()=>['2606:4700:4700::1111'],resolveCname:async()=>['edge.owner-domain.com'],resolveNs:async()=>['ns.owner-domain.com']});
    assert.equal(await collectInfrastructure(db,project,host,[host],resolver('8.8.8.8'),'controlled-test-resolver'),true); await visit();
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours' WHERE project_id=$1",[project]);
    assert.equal(await collectInfrastructure(db,project,host,[host],resolver('1.1.1.1'),'controlled-test-resolver'),true); await visit();
    assert.equal((await db.query("SELECT count(*)::int n FROM infrastructure_dns_observations WHERE project_id=$1 AND record_type='A' AND state='OK'",[project])).rows[0].n,2);
    // Browser-controlled headers, sessions and forged risk fields cannot create LOW.
    for (const phase of ['entry-decision','cta-refresh']) {
      for (const injected of [{},{level:'LOW'},{confidence:'high'},{provenance:'independent'}]) {
        for (const session of ['0123456789abcdef0123456789abcdef','fedcba9876543210fedcba9876543210']) {
          const response=await fetch('http://127.0.0.1:3000/'+phase,{method:'POST',headers:{origin:clone,referer:'https://forged.example/', 'user-agent':'forged-agent','x-forwarded-for':'192.0.2.1','content-type':'text/plain'},body:JSON.stringify({session,signals:{},...injected})});
          assert.equal((await response.json() as {action:string}).action,'OBSERVE_ONLY');
        }
      }
    }
    for (const phase of ['entry-decision','cta-refresh']) {
      for (const signals of [{clickId:'fixture',clickKey:'gclid',medium:'cpc'},{referrerHost:'google.com'},{referrerHost:'referrer.test'},{}]) {
        for (const origin of [clone,claimed]) {
          const response=await fetch('http://127.0.0.1:3000/'+phase,{method:'POST',headers:{origin,referer:'https://forged.example/', 'user-agent':'forged-agent','x-forwarded-for':'203.0.113.7','content-type':'text/plain'},body:JSON.stringify({session:'d'.repeat(32),signals})});
          assert.deepEqual(await response.json(),{action:'OBSERVE_ONLY'});
        }
      }
    }
    // Chromium delivers the real scripts and canary to the gateway in one browser context.
    const adversarial=await browser.newContext({userAgent:'adversarial-test-agent'});
    const browserPage=await adversarial.newPage();
    for (const scenario of [{query:'?utm_medium=cpc&gclid=fixture',referrer:''},{query:'',referrer:'https://google.com/'},{query:'',referrer:'https://referrer.test/'},{query:'',referrer:''}]) {
      const result=browserPage.waitForResponse(r=>r.url().endsWith('/entry-decision'));
      const fallback=browserPage.waitForResponse(r=>r.url().endsWith('/observe/fallback'));
      const canary=browserPage.waitForResponse(r=>r.url().endsWith('/canary/html.gif'));
      await browserPage.goto(clone+'/adversarial'+scenario.query,scenario.referrer ? {referer:scenario.referrer} : undefined);
      assert.deepEqual(await (await result).json(),{action:'OBSERVE_ONLY'});
      assert.equal((await fallback).status(),204); assert.equal((await canary).status(),200);
      assert.equal(new URL(browserPage.url()).pathname,'/adversarial');
    }
    assert.ok((await db.query("SELECT 1 FROM canary_observations WHERE project_id=$1 AND host='localhost' AND source='html_canary'",[project])).rowCount);
    const core=browserPage.waitForResponse(r=>r.url().endsWith('/observe'));
    const coreDecision=browserPage.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await browserPage.reload(); assert.equal((await core).status(),204);
    assert.deepEqual(await (await coreDecision).json(),{action:'OBSERVE_ONLY'});
    await browserPage.route('**/core.js',route=>route.abort());
    const fallbackOnly=browserPage.waitForResponse(r=>r.url().endsWith('/observe/fallback'));
    const blockedCanary=browserPage.waitForResponse(r=>r.url().endsWith('/canary/html.gif'));
    let blockedDecisions=0; browserPage.on('request',request=>{ if (request.url().endsWith('/entry-decision')) blockedDecisions++; });
    await browserPage.reload();
    assert.equal((await fallbackOnly).status(),204); assert.equal((await blockedCanary).status(),200);
    assert.equal(blockedDecisions,0);
    await browserPage.locator('a').click(); await browserPage.waitForURL(clone+'/next');
    await adversarial.close();
    for (const phase of ['entry-decision','cta-refresh']) {
      const malformed=await fetch('http://127.0.0.1:3000/'+phase,{method:'POST',headers:{origin:'not-an-origin','content-type':'text/plain'},body:JSON.stringify({session:'c'.repeat(32),signals:{}})});
      assert.equal(malformed.status,400);
    }
    const assessment=await db.query("SELECT level,source,confidence FROM risk_assessment_days WHERE project_id=$1 AND host='localhost' AND level='UNCERTAIN'",[project]);
    assert.deepEqual(assessment.rows,[{level:'UNCERTAIN',source:'server_default',confidence:'insufficient'}]);
    await saveDraft(db,project,{enabled:false,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}}); await activatePolicy(db,project);
    await page.goto(clone+'/clone'); await page.waitForTimeout(400); assert.equal(page.url(),clone+'/clone');
    const response=await fetch('http://127.0.0.1:3000/entry-decision?risk=LOW&destination=http://evil.test/',{headers:{origin:clone}}); assert.equal(response.status,404);
  } finally {
    if(browser) await browser.close(); app.kill('SIGTERM'); if(app.exitCode===null && app.signalCode===null) await once(app,'exit');
    await db.query('DELETE FROM incidents WHERE project_id=$1',[project]); await db.query('DELETE FROM observations WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_days WHERE project_id=$1',[project]); await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); await new Promise<void>(r=>fixture.close(()=>r()));
  }
});
