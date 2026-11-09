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
    res.writeHead(200,{'content-type':'text/html'}).end(`<a href="/checkout">Checkout</a><script src="http://127.0.0.1:3000/i/${id}/runtime.js"></script><script src="http://127.0.0.1:3000/i/${id}/fallback.js"></script>`);
  }).listen(0,'127.0.0.1');
  await once(fixture,'listening');
  const address=fixture.address(); assert.ok(address && typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','025_installation_signals']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query(await readFile('infra/037_protected_pages.sql','utf8'));
    await db.query("INSERT INTO projects VALUES ('health','Health',$1),('finance','Finance',$1)",[origin]);
    const hp=randomUUID(), fp=randomUUID();
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES ($1,'health',$2,'Health'),($3,'finance',$4,'Finance')",[hp,health,fp,finance]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES ($1,$3,'/saude'),($2,$3,'/financas')",[hp,fp,origin]);
    const env: NodeJS.ProcessEnv={...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,SMTP_PORT:'1',PORT:'3000'};
    delete env.PROJECT_ID; delete env.ALLOWED_ORIGIN;
    child=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:'ignore'});
    for (let i=0;i<100;i++) { try { if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break; } catch { /* starting */ } await new Promise(r=>setTimeout(r,50)); }
    browser=await chromium.launch();
    const page=await browser.newPage();
    for (const path of ['/saude','/financas']) {
      const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
      await page.goto(origin+path); assert.equal((await response).status(),204);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0);
    const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
    await page.goto(`http://localhost:${address.port}/outro-slug`); assert.equal((await response).status(),204);
    const incidents=await db.query('SELECT project_id,host FROM incidents ORDER BY project_id');
    assert.deepEqual(incidents.rows,[{project_id:'health',host:'localhost'}]);
    const decision=await fetch(`http://127.0.0.1:3000/i/${health}/entry-decision`,{method:'POST'});
    assert.deepEqual(await decision.json(),{action:'OBSERVE_ONLY'});
    assert.equal((await fetch(`http://127.0.0.1:3000/i/${health}/observe`,{method:'POST',headers:{'content-type':'text/plain',origin},body:JSON.stringify({origin,pathname:'/saude',signals:{},project_id:'finance'})})).status,400);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await once(child,'exit'); }
    fixture.close(); await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
