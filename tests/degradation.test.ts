import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { degradationState } from '../apps/degradation.js';

test('real gateway/Core/fallback: temporal uncertainty, expiration, recovery and idle retention', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'f44_' + crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL, options});
  const reserve=createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const addr=reserve.address(); assert.ok(addr && typeof addr!=='string');
  const gateway=`http://127.0.0.1:${addr.port}`;
  await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  // This server serves only the owned synthetic page. All observations use the real gateway.
  const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<script src="${gateway}/core.js"></script><script src="${gateway}/fallback.js"></script>`));
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let errors='';
  const wait=async (condition:()=>Promise<boolean>)=>{for(let i=0;i<150;i++){if(await condition()) return; await new Promise(r=>setTimeout(r,30));} throw Error('condition timed out: '+errors);};
  try {
    for(const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','025_installation_signals','026_degradation']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    site.listen(0,'127.0.0.1'); await once(site,'listening');
    const address=site.address(); assert.ok(address && typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    await db.query("INSERT INTO projects VALUES('lab','Lab','http://localhost:12345'),('other','Other','http://localhost:12346')");
    child=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'lab',PORT:String(addr.port),SMTP_PORT:'1',LAB_CONTROLLED_ORIGIN:origin,ALLOWED_ORIGIN:'',GATEWAY_MODE:undefined,GATEWAY_TRANSPORT:'',PUBLIC_GATEWAY_HOST:''},stdio:['ignore','ignore','pipe']});
    child.stderr?.on('data',chunk=>{errors+=String(chunk);});
    await wait(async()=>{try{return (await fetch(gateway+'/healthz')).ok;}catch{return false;}});
    browser=await chromium.launch(); const page=await browser.newPage();
    const count=async(source:string)=>(await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='lab' AND source=$1",[source])).rows[0].n;
    const visit=async(core:boolean)=>{
      const before=await count('fallback');
      const fallback=page.waitForResponse(r=>r.url()===gateway+'/observe/fallback');
      const coreResponse=core?page.waitForResponse(r=>r.url()===gateway+'/observe'):undefined;
      await page.goto(origin); assert.equal((await fallback).status(),204);
      if(coreResponse) assert.equal((await coreResponse).status(),204);
      await wait(async()=>await count('fallback')>before);
    };
    assert.equal(await degradationState(db,'lab','127.0.0.1'),'UNKNOWN');
    await visit(true);
    assert.equal(await count('core'),1);
    assert.equal(await degradationState(db,'lab','127.0.0.1'),'UNKNOWN');
    // Advance stored server timestamps rather than wait 30 real minutes; runtime and transport stay real.
    const age=async(minutes:number)=>db.query("UPDATE degradation_events SET observed_at=clock_timestamp()-$1*interval '1 minute',bucket=date_trunc('minute',clock_timestamp()-$1*interval '1 minute') WHERE project_id='lab' AND observed_at>clock_timestamp()-interval '2 minutes'",[minutes]);
    await age(20); await visit(true); await age(15);
    await page.route('**/core.js',route=>route.abort());
    await visit(false); await age(3); await visit(false);
    assert.equal(await degradationState(db,'lab','127.0.0.1'),'POSSIBLE_DEGRADATION');
    assert.equal(await degradationState(db,'other','127.0.0.1'),'UNKNOWN');
    assert.equal(await degradationState(db,'lab','other.test'),'UNKNOWN');
    // All recent sources expire: current state changes, historical possible event survives.
    await db.query("UPDATE degradation_events SET observed_at=observed_at-interval '3 minutes',bucket=bucket-interval '3 minutes' WHERE project_id='lab'");
    await wait(async()=> (await db.query("SELECT state FROM degradation_audit WHERE project_id='lab' AND host='127.0.0.1' ORDER BY observed_at DESC LIMIT 1")).rows[0]?.state==='UNKNOWN');
    assert.equal(await degradationState(db,'lab','127.0.0.1'),'UNKNOWN');
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='lab' AND state='POSSIBLE_DEGRADATION'")).rows[0].n,1);
    await page.unroute('**/core.js'); await visit(true);
    await wait(async()=>await count('core')===3);
    assert.equal(await degradationState(db,'lab','127.0.0.1'),'UNKNOWN');
    // Spoofed headers are claims, never verified identity; mismatched claims are rejected.
    assert.equal((await fetch(gateway+'/observe',{method:'POST',headers:{origin,'content-type':'text/plain'},body:'http://spoof.test'})).status,400);
    assert.equal((await fetch(gateway+'/observe/fallback',{method:'POST',headers:{origin:'http://spoof.test','content-type':'text/plain'},body:'http://spoof.test'})).status,204);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE host='spoof.test'")).rows[0].n,0);
    // A matching forged Origin/body is still an unauthenticated claim, deduplicated in its minute.
    await fetch(gateway+'/observe/fallback',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin});
    const audit=await db.query('SELECT uncertainty FROM degradation_audit');
    assert.ok(audit.rows.every(r=>r.uncertainty==='UNAUTHENTICATED_CLAIMS'));
    assert.equal((await db.query('SELECT count(*)::int n FROM installation_signals')).rows[0].n,0);
    // No further requests: periodic gateway maintenance clears expired rows separately for both projects.
    await db.query("INSERT INTO degradation_events(project_id,host,source,bucket,observed_at) VALUES('lab','expired.test','core',now()-interval '2 days',now()-interval '2 days'),('other','expired.test','core',now()-interval '2 days',now()-interval '2 days')");
    await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start,observed_at) VALUES('lab','expired.test','UNKNOWN',now()-interval '8 days',now()-interval '8 days'),('other','expired.test','UNKNOWN',now()-interval '8 days',now()-interval '8 days')");
    await wait(async()=> (await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='lab' AND host='expired.test'")).rows[0].n===0);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='lab' AND observed_at<now()-interval '7 days'")).rows[0].n,0);
    await wait(async()=> (await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='other'")).rows[0].n===0);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='other'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='other' AND host='expired.test'")).rows[0].n,0);
  } finally {
    await browser?.close(); if(child && child.exitCode===null){child.kill();await once(child,'exit');}
    if(site.listening) await new Promise<void>(resolve=>site.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
