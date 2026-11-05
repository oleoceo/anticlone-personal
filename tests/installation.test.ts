import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { disableInstallation, enableInstallation, installationDiagnostic, recordInstallationClaim } from '../apps/installation.js';

test('installation claims: upgrade, controlled browser, isolation and untrusted replay', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='install_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<a href="/checkout">Checkout</a><script src="http://127.0.0.1:3000/runtime.js"></script><script src="http://127.0.0.1:3000/fallback.js"></script>`));
  try {
    for (const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    site.listen(0,'127.0.0.1'); await once(site,'listening');
    const address=site.address(); assert.ok(address && typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    await db.query("INSERT INTO projects VALUES('one','One',$1),('two','Two','http://other.test')",[origin]);
    const migration=await readFile('infra/025_installation_signals.sql','utf8');
    await db.query(migration); await db.query(migration);
    assert.equal((await db.query('SELECT count(*)::int n FROM projects')).rows[0].n,2);
    const enabled=await enableInstallation(db,'one'); const again=await enableInstallation(db,'one');
    assert.equal(enabled.installation?.id,again.installation?.id);
    await enableInstallation(db,'two');
    child=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'one',ALLOWED_ORIGIN:origin,PORT:'3000',SMTP_PORT:'1'},stdio:'ignore'});
    for (let i=0;i<100;i++) {try {if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break;} catch { /* startup */ } await new Promise(r=>setTimeout(r,50));}
    browser=await chromium.launch(); const page=await browser.newPage();
    const fallback=page.waitForResponse(r=>r.url().endsWith('/observe/fallback'));
    await page.goto(origin); await fallback;
    for (let i=0;i<100 && (await installationDiagnostic(db,'one')).signals.length<2;i++) await new Promise(r=>setTimeout(r,50));
    const diagnostic=await installationDiagnostic(db,'one');
    assert.equal(diagnostic.status,'NOT_VERIFIED'); assert.equal(diagnostic.controlledCheck,null);
    assert.deepEqual(diagnostic.signals.map(s=>s.source),['core','fallback']);
    assert.ok(diagnostic.signals.every(s=>s.confidence==='UNAUTHENTICATED_CLAIM'));
    assert.equal((await installationDiagnostic(db,'two')).signals.length,0);
    await recordInstallationClaim(db,'one','http://other.test','core');
    for (let i=0;i<5;i++) await recordInstallationClaim(db,'one',origin,'core');
    assert.equal((await db.query('SELECT count(*)::int n FROM installation_signals')).rows[0].n,2);
    await disableInstallation(db,'two');
    await recordInstallationClaim(db,'two','http://other.test','core');
    assert.equal((await installationDiagnostic(db,'two')).signals.length,0);
    assert.equal((await enableInstallation(db,'two')).installation?.enabled,true);
    await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
    // Old code can still read its pre-migration data after the additive upgrade.
    assert.equal((await db.query("SELECT origin FROM projects WHERE id='one'")).rows[0].origin,origin);
  } finally {
    await browser?.close(); if(child && child.exitCode===null) {child.kill(); await once(child,'exit');}
    if(site.listening) await new Promise<void>(resolve=>site.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
