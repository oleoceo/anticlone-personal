import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { gatewayMode } from '../apps/gateway-mode.js';

test('pilot configuration is exact, HTTPS only, bounded and separate from laboratory', () => {
  const primary = 'https://owner.test';
  const env = {GATEWAY_MODE:'PILOT_OBSERVE', PILOT_ORIGINS:JSON.stringify([primary,'https://preview.owner.test'])};
  assert.deepEqual(gatewayMode(env, primary).origins, [primary,'https://preview.owner.test']);
  for (const value of ['http://owner.test','https://127.0.0.1','https://localhost','https://x.local','https://*.owner.test','https://owner.test/path','https://user@owner.test','https://owner.test:444','https://owner.test.','https://OWNER.test']) {
    assert.throws(() => gatewayMode({...env,PILOT_ORIGINS:JSON.stringify([primary,value])},primary));
  }
  for (const patch of [{LAB_CONTROLLED_RISK:'LOW'}, {LAB_CONTROLLED_ORIGIN:primary}, {ALLOWED_ORIGIN:primary}, {PILOT_ORIGINS:'[]'}, {PILOT_ORIGINS:'invalid'}, {PILOT_ORIGINS:JSON.stringify([primary,primary])}, {GATEWAY_MODE:'typo'}]) assert.throws(() => gatewayMode({...env,...patch},primary));
  assert.throws(() => gatewayMode({PILOT_ORIGINS:env.PILOT_ORIGINS},primary));
  assert.deepEqual(gatewayMode({},primary), {pilot:false,origins:[primary]});
});

test('pilot browser: multiple exact origins, untrusted copy, uncertain decisions and gateway failure', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'pilot_' + crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options = `-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','030_infrastructure_dns']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  await db.query("INSERT INTO projects VALUES('pilot','Pilot','https://owner.test')");
  for (const file of ['007_protection_policy','010_policy_allocation','012_cta_policy']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  const allocation = {PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
  await db.query("INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation) VALUES('pilot',1,true,'https://owner.test/approved',true,$1)",[allocation]);
  await db.query("INSERT INTO active_protection_policies VALUES('pilot',1)");
  await db.query("INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES('pilot',1,true,'checkout','/',$1)",[allocation]);
  await db.query("INSERT INTO active_cta_policies VALUES('pilot',1)");
  const reserve = createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const address = reserve.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath,['dist/apps/server.js'], {env:{...process.env, PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'pilot',PORT:String(port),SMTP_PORT:'1',GATEWAY_MODE:'PILOT_OBSERVE',PILOT_ORIGINS:'["https://owner.test","https://preview.owner.test"]',ALLOWED_ORIGIN:'',LAB_CONTROLLED_ORIGIN:'',LAB_CONTROLLED_RISK:'',INFRASTRUCTURE_DNS_ENABLED:''},stdio:'ignore'});
  const browser = await chromium.launch();
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i=0;i<100&&!ready;i++) { try { ready = (await fetch(base+'/runtime.js')).ok; } catch { /* startup */ } if (!ready) await new Promise(resolve => setTimeout(resolve,50)); }
    assert.ok(ready);
    for (const path of ['/entry-decision','/cta-refresh']) {
      const response = await fetch(base+path,{method:'POST',headers:{origin:'https://copy.test','content-type':'text/plain'},body:JSON.stringify({session:'a'.repeat(32),signals:{medium:'cpc'}})});
      assert.deepEqual(await response.json(),{action:'OBSERVE_ONLY'});
    }
    for (const host of ['owner.test','preview.owner.test','copy.test','owner.test.evil.test']) {
      const page = await browser.newPage();
      await page.route('https://gateway.test/**', async route => {
        const request = route.request();
        const response = await fetch(base+new URL(request.url()).pathname, {method:request.method(),headers:{origin:`https://${host}`,'content-type':'text/plain'},body:request.postData() ?? undefined});
        await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type') ?? 'text/plain','access-control-allow-origin':'*'},body:Buffer.from(await response.arrayBuffer())});
      });
      await page.route(`https://${host}/**`, route => route.fulfill({contentType:'text/html',body:'<a href="/checkout">Native</a><script src="https://gateway.test/runtime.js"></script>'}));
      const observed = page.waitForResponse(response => response.url()==='https://gateway.test/observe');
      const decision = page.waitForResponse(response => response.url()==='https://gateway.test/entry-decision');
      await page.goto(`https://${host}/?utm_medium=cpc`);
      assert.equal((await observed).status(),204);
      assert.deepEqual(await (await decision).json(),{action:'OBSERVE_ONLY'});
      await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
      await page.close();
    }
    const incidents = await db.query('SELECT host FROM incidents ORDER BY host');
    assert.deepEqual(incidents.rows,[{host:'copy.test'},{host:'owner.test.evil.test'}]);
    await db.query(`INSERT INTO infrastructure_dns_observations(incident_id,project_id,host,record_type,result,source,state,valid_until,limitations)
      SELECT id,project_id,host,'A','["8.8.8.8"]'::jsonb,'controlled-test-resolver','OK',now(),'TTL unknown' FROM incidents WHERE project_id='pilot' AND host='copy.test'`);
    for (const path of ['/entry-decision','/cta-refresh']) {
      const response=await fetch(base+path,{method:'POST',headers:{origin:'https://copy.test','content-type':'text/plain'},body:JSON.stringify({session:'a'.repeat(32),signals:{medium:'cpc'}})});
      assert.deepEqual(await response.json(),{action:'OBSERVE_ONLY'});
    }
    const risks = await db.query('SELECT level,source,evaluator_version,evidence_kind,evidence_provenance,evidence_reliability FROM risk_assessment_days');
    assert.equal(risks.rowCount,4);
    assert.ok(risks.rows.every(row => row.level==='UNCERTAIN' && row.source==='server_default' && row.evaluator_version==='conservative-risk-v3'));
    assert.ok(risks.rows.every(row => row.evidence_kind==='paid_utm' && row.evidence_provenance==='browser' && row.evidence_reliability==='uncorroborated'));
    const page = await browser.newPage();
    await page.route('https://gateway.test/**', route => route.abort());
    await page.route('https://owner.test/**', route => route.fulfill({contentType:'text/html',body:'<a href="/checkout">Native</a><script src="https://gateway.test/runtime.js"></script>'}));
    await page.goto('https://owner.test/'); await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
  } finally {
    await browser.close();
    if (child.exitCode===null && child.signalCode===null) {child.kill('SIGTERM');await once(child,'exit');}
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
