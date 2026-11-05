import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { saveDraft, activatePolicy } from '../apps/protection-policy.js';

test('GS06 integration: persisted policy, controlled LOW and original', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await db.query(await readFile('infra/008_traffic_observations.sql', 'utf8'));
  await db.query(await readFile('infra/009_risk_assessments.sql', 'utf8'));
  for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','010_policy_allocation','018_notification_budget','019_alert_outbox_expiry']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  const project='gs06_'+crypto.randomUUID();
  const fixture=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<h1>site</h1><a href="/next">next</a><script src="http://127.0.0.1:3000/runtime.js"></script>'));
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening'); const address=fixture.address(); if (!address || typeof address==='string') throw Error('address');
  const original=`http://127.0.0.1:${address.port}`, clone=`http://localhost:${address.port}`;
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
  await db.query('INSERT INTO page_redirect_policies VALUES($1,1,true,$2)',[project,original+'/approved']);
  const start = (risk = 'LOW') => spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:risk},stdio:['ignore','ignore','inherit']});
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
    const assessment=await db.query("SELECT level,source,confidence FROM risk_assessment_days WHERE project_id=$1 AND host='localhost' AND level='UNCERTAIN'",[project]);
    assert.deepEqual(assessment.rows,[{level:'UNCERTAIN',source:'server_default',confidence:'insufficient'}]);
    await saveDraft(db,project,{enabled:false,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}}); await activatePolicy(db,project);
    await page.goto(clone+'/clone'); await page.waitForTimeout(400); assert.equal(page.url(),clone+'/clone');
    const response=await fetch('http://127.0.0.1:3000/entry-decision?risk=LOW&destination=http://evil.test/',{headers:{origin:clone}}); assert.equal(response.status,404);
  } finally {
    if(browser) await browser.close(); app.kill('SIGTERM'); if(app.exitCode===null && app.signalCode===null) await once(app,'exit');
    await db.query('DELETE FROM incidents WHERE project_id=$1',[project]); await db.query('DELETE FROM observations WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_days WHERE project_id=$1',[project]); await db.end(); await new Promise<void>(r=>fixture.close(()=>r()));
  }
});
