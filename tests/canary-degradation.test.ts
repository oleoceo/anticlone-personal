import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { degradationState } from '../apps/degradation.js';

test('F44 canaries through real gateway and browser: bounded temporal claims remain uncertain', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'canary_' + crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options = `-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const reserve = createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const addr=reserve.address(); assert.ok(addr && typeof addr!=='string');
  const gateway=`http://127.0.0.1:${addr.port}`;
  await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<script src="${gateway}/core.js"></script><img src="${gateway}/canary/html.gif"><span style="display:block;width:1px;height:1px;background-image:url(${gateway}/canary/css.gif)"></span>`));
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let errors='';
  const wait=async (condition:()=>Promise<boolean>)=>{for(let i=0;i<200;i++){if(await condition()) return; await new Promise(r=>setTimeout(r,30));} throw Error('condition timed out: '+errors);};
  try {
    for(const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','025_installation_signals','026_degradation','027_canary_degradation']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    // Applying the additive migration twice and after 026 is supported.
    await db.query(await readFile('infra/027_canary_degradation.sql','utf8'));
    site.listen(0,'127.0.0.1'); await once(site,'listening');
    const address=site.address(); assert.ok(address && typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`, host='127.0.0.1';
    await db.query("INSERT INTO projects VALUES('lab','Lab','http://localhost:12345'),('other','Other','http://localhost:12346')");
    child=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'lab',PORT:String(addr.port),SMTP_PORT:'1',LAB_CONTROLLED_ORIGIN:origin,ALLOWED_ORIGIN:'',GATEWAY_MODE:undefined,GATEWAY_TRANSPORT:'',PUBLIC_GATEWAY_HOST:''},stdio:['ignore','ignore','pipe']});
    child.stderr?.on('data',chunk=>{errors+=String(chunk);});
    await wait(async()=>{try{return (await fetch(gateway+'/healthz')).ok;}catch{return false;}});
    // Advance the startup uncertainty marker, just as the observations below
    // advance server timestamps instead of waiting 30 minutes in real time.
    await wait(async()=> (await db.query("SELECT count(*)::int n FROM degradation_collection_gaps WHERE project_id='lab'")).rows[0].n===1);
    await db.query("UPDATE degradation_collection_gaps SET last_dropped_at=now()-interval '31 minutes' WHERE project_id='lab'");
    browser=await chromium.launch(); const page=await browser.newPage();
    const count=async(source:string)=>(await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='lab' AND host=$2 AND origin=$3 AND source=$1",[source,host,origin])).rows[0].n;
    const state=()=>degradationState(db,'lab',host,origin);
    const visit=async(core:boolean)=>{
      const sources=core?['html_canary','css_canary','core']:['html_canary','css_canary'];
      const before=await Promise.all(sources.map(count));
      const html=page.waitForResponse(r=>r.url()===gateway+'/canary/html.gif');
      const css=page.waitForResponse(r=>r.url()===gateway+'/canary/css.gif');
      const coreResponse=core?page.waitForResponse(r=>r.url()===gateway+'/observe'):undefined;
      await page.goto(origin); assert.equal((await html).status(),200); assert.equal((await css).status(),200);
      if(coreResponse) assert.equal((await coreResponse).status(),204);
      // HTTP completion precedes the asynchronous temporal journal. Every
      // expected source must commit before callers may age or delete evidence.
      await wait(async()=>{
        const persisted=await Promise.all(sources.map(count));
        return persisted.every((n,i)=>n===before[i]+1);
      });
    };
    const age=async(minutes:number)=>db.query("UPDATE degradation_events SET observed_at=clock_timestamp()-$1*interval '1 minute',bucket=date_trunc('minute',clock_timestamp()-$1*interval '1 minute') WHERE project_id='lab' AND observed_at>clock_timestamp()-interval '2 minutes'",[minutes]);
    assert.equal(await state(),'UNKNOWN');
    // Deterministically hold Core's INSERT after both canaries and the 204.
    // A canary-only barrier returns too soon under this exact schedule.
    const blocker=await db.connect();
    const lockId=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    let pendingVisit: Promise<void> | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock(44146,$1)',[lockId]);
      await db.query(`CREATE FUNCTION delay_core() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN IF NEW.source='core' THEN PERFORM pg_advisory_xact_lock(44146,${lockId}); END IF; RETURN NEW; END $body$;
        CREATE TRIGGER delay_core BEFORE INSERT ON degradation_events FOR EACH ROW EXECUTE FUNCTION delay_core()`);
      await page.route('**/observe',async route=>{
        await wait(async()=>await count('html_canary')===1 && await count('css_canary')===1);
        await route.continue();
      });
      const response=page.waitForResponse(r=>r.url()===gateway+'/observe');
      let settled=false;
      pendingVisit=visit(true).finally(()=>{settled=true;});
      // Attach rejection handling immediately; await below still propagates it.
      void pendingVisit.catch(()=>{});
      assert.equal((await response).status(),204);
      await wait(async()=>(await db.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=44146 AND objid=$1 AND NOT granted",[lockId])).rows[0].n===1);
      assert.equal(await count('core'),0);
      assert.equal(settled,false,'visit must wait for Core persistence after HTTP 204');
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(44146,$1)',[lockId]); blocker.release();
      await pendingVisit;
      await page.unroute('**/observe');
      await db.query('DROP TRIGGER IF EXISTS delay_core ON degradation_events; DROP FUNCTION IF EXISTS delay_core()');
    }
    assert.equal(await count('core'),1);
    assert.equal(await state(),'UNKNOWN');
    await age(20); await visit(true); await age(15);
    await page.route('**/core.js',route=>route.abort());
    await visit(false); assert.equal(await state(),'UNKNOWN');
    await age(3); await visit(false);
    assert.equal(await state(),'POSSIBLE_DEGRADATION');
    const audit=await db.query("SELECT evidence,uncertainty FROM degradation_audit WHERE project_id='lab' AND state='POSSIBLE_DEGRADATION'");
    assert.equal(audit.rows[0].uncertainty,'UNAUTHENTICATED_CLAIMS');
    assert.ok(audit.rows[0].evidence.some((v:{source:string,origin:string,observed_at:string})=>v.source==='html_canary' && v.origin===origin && v.observed_at));
    assert.ok(audit.rows[0].evidence.some((v:{source:string})=>v.source==='css_canary'));
    assert.equal(await degradationState(db,'other',host,origin),'UNKNOWN');
    assert.equal(await degradationState(db,'lab','localhost',origin),'UNKNOWN');
    // Identical claims are deduplicated per source and minute; invalid or different origins do not contribute.
    const before=await count('html_canary');
    for(const referer of [origin,origin,'','invalid','http://localhost:12345/',origin.replace('127.0.0.1','localhost')])
      assert.equal((await fetch(gateway+'/canary/html.gif',{headers:referer?{referer}:{}})).status,200);
    await new Promise(r=>setTimeout(r,200)); assert.equal(await count('html_canary'),before);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE host<>'127.0.0.1'")).rows[0].n,0);
    // No traffic: expiry produces UNKNOWN without another request.
    await db.query("UPDATE degradation_events SET observed_at=observed_at-interval '3 minutes',bucket=bucket-interval '3 minutes' WHERE project_id='lab'");
    await wait(async()=> (await db.query("SELECT state FROM degradation_audit WHERE project_id='lab' AND host=$1 ORDER BY observed_at DESC LIMIT 1",[host])).rows[0]?.state==='UNKNOWN');
    assert.equal(await state(),'UNKNOWN');
    await page.unroute('**/core.js'); await visit(true); assert.equal(await state(),'UNKNOWN');
    // Each independent resource can support F44 while the other is blocked.
    for (const only of ['html','css'] as const) {
      await db.query("DELETE FROM degradation_events WHERE project_id='lab'");
      await visit(true); await age(20); await visit(true); await age(15);
      await page.route('**/core.js',route=>route.abort());
      const blocked=only==='html'?'css':'html';
      await page.route(`**/canary/${blocked}.gif`,route=>route.abort());
      const source=`${only}_canary`;
      const visitOnly=async()=>{
        const before=await count(source);
        const response=page.waitForResponse(r=>r.url()===`${gateway}/canary/${only}.gif`);
        await page.goto(origin); assert.equal((await response).status(),200);
        await wait(async()=>await count(source)>before);
      };
      await visitOnly(); await age(3); await visitOnly();
      assert.equal(await state(),'POSSIBLE_DEGRADATION');
      await page.unroute('**/core.js'); await page.unroute(`**/canary/${blocked}.gif`);
    }
    await db.query("DELETE FROM degradation_events WHERE project_id='lab'");
    // A forged matching Referer is indistinguishable from the browser claim.
    // It is retained as a claim, not authentication or proof of installation.
    assert.equal((await fetch(gateway+'/canary/html.gif',{headers:{referer:origin}})).status,200);
    await wait(async()=>await count('html_canary')===1);
    assert.equal(await state(),'UNKNOWN');
    await db.query("INSERT INTO degradation_events(project_id,host,source,bucket,observed_at,origin) VALUES('lab','expired','html_canary',now()-interval '2 days',now()-interval '2 days',$1),('other','expired','html_canary',now()-interval '2 days',now()-interval '2 days',$1)",[origin]);
    await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start,observed_at) VALUES('lab','expired','UNKNOWN',now()-interval '8 days',now()-interval '8 days'),('other','expired','UNKNOWN',now()-interval '8 days',now()-interval '8 days')");
    await wait(async()=> (await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='lab' AND host='expired'")).rows[0].n===0);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='other' AND host='expired'")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='lab' AND host='expired'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='other' AND host='expired'")).rows[0].n,1);
    // Legacy core rows have no origin and cannot establish a canary baseline.
    await db.query("DELETE FROM degradation_events WHERE project_id='lab'");
    await db.query(`INSERT INTO degradation_events(project_id,host,source,bucket,observed_at,origin)
      VALUES ('lab',$1,'core',date_trunc('minute',now()-interval '20 minutes'),now()-interval '20 minutes',NULL),
      ('lab',$1,'core',date_trunc('minute',now()-interval '15 minutes'),now()-interval '15 minutes',NULL),
      ('lab',$1,'html_canary',date_trunc('minute',now()-interval '3 minutes'),now()-interval '3 minutes',$2),
      ('lab',$1,'html_canary',date_trunc('minute',now()),now(),$2)`,[host,origin]);
    assert.equal(await state(),'UNKNOWN');
    await db.query(`INSERT INTO degradation_events(project_id,host,source,bucket,observed_at)
      VALUES ('lab',$1,'fallback',date_trunc('minute',now()-interval '3 minutes'),now()-interval '3 minutes'),
      ('lab',$1,'fallback',date_trunc('minute',now()),now())`,[host]);
    assert.equal(await state(),'POSSIBLE_DEGRADATION');
    const legacyAudit=await db.query("SELECT evidence FROM degradation_audit WHERE project_id='lab' AND host=$1 ORDER BY observed_at DESC LIMIT 1",[host]);
    assert.ok(legacyAudit.rows[0].evidence.some((v:{source:string,origin:string|null})=>v.source==='fallback' && v.origin===null));
    assert.ok(legacyAudit.rows[0].evidence.some((v:{source:string,origin:string|null})=>v.source==='core' && v.origin===null));
    await db.query("DELETE FROM degradation_events WHERE project_id='lab' AND source='fallback'");
    // The existing per-project bound applies to canaries as well as Core/fallback.
    await db.query("UPDATE degradation_events SET origin=$1 WHERE project_id='lab'",[origin]);
    assert.equal(await state(),'POSSIBLE_DEGRADATION');
    await db.query("INSERT INTO degradation_events(project_id,host,source,bucket) SELECT 'lab','limit-'||n,'core',date_trunc('minute',now()) FROM generate_series(1,9996) n");
    await fetch(gateway+'/observe',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin});
    await new Promise(r=>setTimeout(r,300));
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='lab'")).rows[0].n,10000);
    assert.equal(await state(),'UNKNOWN');
    await db.query("DELETE FROM degradation_events WHERE project_id='lab' AND host LIKE 'limit-%'");
    assert.equal(await state(),'UNKNOWN');
    await db.query("UPDATE degradation_collection_gaps SET last_dropped_at=now()-interval '31 minutes' WHERE project_id='lab'");
    assert.equal(await state(),'POSSIBLE_DEGRADATION');
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='other'")).rows[0].n,1);
    // A failure before the temporal journal is reached also invalidates absence.
    await db.query('ALTER TABLE incidents RENAME TO unavailable_incidents');
    try {
      assert.equal((await fetch(gateway+'/observe',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin})).status,503);
      await wait(async()=>await state()==='UNKNOWN');
    } finally { await db.query('ALTER TABLE unavailable_incidents RENAME TO incidents'); }
    await db.query("UPDATE degradation_collection_gaps SET last_dropped_at=now()-interval '31 minutes' WHERE project_id='lab'");
    assert.equal(await state(),'POSSIBLE_DEGRADATION');
    // A gateway rejection is known collection loss and invalidates the window.
    let rejected=false;
    for(let i=0;i<80 && !rejected;i++) rejected=(await fetch(gateway+'/canary/html.gif')).status===429;
    assert.ok(rejected);
    await wait(async()=>await state()==='UNKNOWN');
  } finally {
    await browser?.close(); if(child && child.exitCode===null){child.kill();await once(child,'exit');}
    if(site.listening) await new Promise<void>(resolve=>site.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
