import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compilePreviousCode, previousCodeSha } from './previous-code.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { disableInstallation, enableInstallation, installationDiagnostic, recordInstallationClaim } from '../apps/installation.js';

test('installation claims: upgrade, browser, isolation, replay and actual previous-code rollback', {timeout:120000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='install_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let previousDirectory: string | undefined;
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
    // Stop the new process, then execute the actual pre-025 application against this upgraded database.
    child.kill(); await once(child,'exit');
    const persisted=await db.query('SELECT * FROM installations ORDER BY project_id');
    const signals=await db.query('SELECT * FROM installation_signals ORDER BY project_id,source');
    previousDirectory=await compilePreviousCode();
    assert.equal(previousCodeSha,'73bee1c25507ca617df09e243a08b80ab99484d7');
    child=spawn(process.execPath,[join(previousDirectory,'dist/apps/server.js')],{cwd:previousDirectory,env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'one',ALLOWED_ORIGIN:origin,PORT:'3000',SMTP_PORT:'1'},stdio:'ignore'});
    let ready=false;
    for (let i=0;i<100;i++) {try {if ((await fetch('http://127.0.0.1:3000/healthz')).ok) {ready=true;break;}} catch { /* startup */ } await new Promise(r=>setTimeout(r,50));}
    assert.ok(ready,'previous application starts on the 025 schema');
    const oldRuntime=await fetch('http://127.0.0.1:3000/runtime.js'); assert.equal(oldRuntime.status,200);
    const oldFallback=page.waitForResponse(r=>r.url().endsWith('/observe/fallback'));
    await page.goto(origin); assert.equal((await oldFallback).status(),204);
    await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
    // Old observation writes remain operational; new opt-in data is untouched.
    const observed=await fetch('http://127.0.0.1:3000/observe',{method:'POST',headers:{'content-type':'text/plain',origin:'http://rollback-copy.test'},body:'http://rollback-copy.test'});
    assert.equal(observed.status,204);
    assert.equal((await db.query("SELECT count(*)::int n FROM observations WHERE host='rollback-copy.test'")).rows[0].n,1);
    assert.deepEqual((await db.query('SELECT * FROM installations ORDER BY project_id')).rows,persisted.rows);
    assert.deepEqual((await db.query('SELECT * FROM installation_signals ORDER BY project_id,source')).rows,signals.rows);
  } finally {
    await browser?.close(); if(child && child.exitCode===null) {child.kill(); await once(child,'exit');}
    if(previousDirectory) await rm(previousDirectory,{recursive:true,force:true});
    if(site.listening) await new Promise<void>(resolve=>site.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
