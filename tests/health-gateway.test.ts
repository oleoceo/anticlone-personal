import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { SMTPServer } from 'smtp-server';
import { enableInstallation } from '../apps/installation.js';
import { configureHealth } from '../apps/health-alerts.js';

test('gateway reconciles health episodes after restart and a real maintenance fault', {timeout:60000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='health_gateway_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const reserve=createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const addr=reserve.address(); assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const base=`http://127.0.0.1:${addr.port}`;
  const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Laboratorio</title>')).listen(0,'127.0.0.1');
  await once(site,'listening');
  const siteAddress=site.address(); assert.ok(siteAddress && typeof siteAddress !== 'string');
  const origin=`http://127.0.0.1:${siteAddress.port}`;
  const browser=await chromium.launch();
  let rejectMail=true, accepted=0;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS'],onData(stream,_session,callback){
    stream.resume(); stream.on('end',()=>{if(rejectMail) callback(new Error('local failure')); else { accepted++; callback(); }});
  }});
  const smtpServer=smtp.listen(0,'127.0.0.1'); await once(smtpServer,'listening');
  const smtpAddress=smtpServer.address(); assert.ok(smtpAddress && typeof smtpAddress !== 'string');
  let child:ReturnType<typeof spawn>|undefined, logs='';
  const wait=async (condition:()=>Promise<boolean>)=>{const deadline=Date.now()+10000; do { if(await condition()) return; await new Promise(r=>setTimeout(r,30)); } while(Date.now()<deadline); throw Error('condition timed out: '+logs);};
  const start=async()=>{
    child=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'one',PORT:String(addr.port),SMTP_PORT:String(smtpAddress.port),ALLOWED_ORIGIN:'',GATEWAY_MODE:undefined,GATEWAY_TRANSPORT:'',PUBLIC_GATEWAY_HOST:'',LAB_CONTROLLED_ORIGIN:''},stdio:['ignore','ignore','pipe']});
    child.stderr?.on('data',chunk=>{logs+=String(chunk);});
    await wait(async()=>{try{return (await fetch(base+'/healthz')).ok;}catch{return false;}});
  };
  const stop=async()=>{if(child && child.exitCode===null){child.kill();await once(child,'exit');}};
  try {
    for(const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','025_installation_signals','028_health_alerts']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    await db.query("INSERT INTO projects VALUES('one','One',$1),('two','Two','http://other.test')",[origin]);
    await enableInstallation(db,'one'); await enableInstallation(db,'two');
    await configureHealth(db,'one',true,60,true); await configureHealth(db,'two',true,60,true);
    await db.query("INSERT INTO installation_signals(project_id,source) VALUES('one','core')");
    await start();
    await wait(async()=>(await db.query("SELECT first_observed_at IS NULL AS ready FROM installation_last_signal WHERE project_id='one'")).rows[0].ready);
    const page=await browser.newPage(); await page.goto(origin);
    const browserStatus=await page.evaluate(async ({base,origin})=>(await fetch(base+'/observe',{method:'POST',headers:{'content-type':'text/plain'},body:origin})).status,{base,origin});
    assert.equal(browserStatus,204);
    // The HTTP response precedes the asynchronous installation claim.
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM installation_last_signal WHERE project_id='one' AND first_observed_at IS NOT NULL")).rows[0].n===1);
    await db.query("UPDATE installation_last_signal SET first_observed_at=clock_timestamp()-interval '4 minutes',last_observed_at=clock_timestamp()-interval '2 minutes' WHERE project_id='one'");
    // An independent canary claim from the controlled page is persisted before evaluation.
    await page.evaluate(async base=>{ await new Promise<void>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve();image.onerror=()=>reject(Error('canary failed'));image.src=base+'/canary/html.gif';}); },base);
    await wait(async()=>(await db.query("SELECT last_activity_at IS NOT NULL AS persisted FROM installation_last_signal WHERE project_id='one'")).rows[0].persisted);

    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='one' AND kind='INACTIVE'")).rows[0].n===1);
    await wait(async()=>(await db.query("SELECT attempts FROM health_delivery")).rows[0].attempts===1);
    await stop();
    await db.query("UPDATE health_delivery SET next_attempt=clock_timestamp()-interval '1 second'");
    rejectMail=false;
    await start();
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_history WHERE event='SENT'")).rows[0].n===1);
    assert.equal((await db.query('SELECT attempts FROM health_delivery')).rows[0].attempts,2); assert.equal(accepted,1);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='one' AND kind='INACTIVE'")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='two'")).rows[0].n,0);
    await db.query('ALTER TABLE observations RENAME TO observations_unavailable');
    await wait(async()=>logs.includes('maintenance MAINTENANCE_ERROR'));
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='one' AND source='maintenance' AND recovered_at IS NULL")).rows[0].n===1);
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_history h JOIN health_episodes e ON e.id=h.episode_id WHERE e.source='maintenance' AND h.event='ATTEMPT'")).rows[0].n===1);
    await db.query('ALTER TABLE observations_unavailable RENAME TO observations');
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='one' AND kind='OPERATIONAL' AND recovered_at IS NOT NULL")).rows[0].n===1);
    // A real optional operation failure is persisted, survives restart, and is
    // recovered only after the same operation succeeds in the new process.
    await db.query('ALTER TABLE installation_signals RENAME TO unavailable_signals');
    assert.equal((await fetch(base+'/observe/fallback',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin})).status,204);
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='installation_claim' AND recovered_at IS NULL")).rows[0].n===1);
    await wait(async()=>(await db.query("SELECT first_observed_at IS NULL AS invalidated FROM installation_last_signal WHERE project_id='one'")).rows[0].invalidated);
    await stop();
    await db.query('ALTER TABLE unavailable_signals RENAME TO installation_signals');
    // Wait for startup retention to complete before inducing the next fault.
    await db.query("UPDATE installation_signals SET last_observed_at=clock_timestamp()-interval '8 days' WHERE project_id='one' AND source='core'");
    await start();
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='one' AND source='core'")).rows[0].n===0);
    assert.equal((await fetch(base+'/observe/fallback',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin})).status,204);
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='installation_claim' AND recovered_at IS NOT NULL")).rows[0].n===1);
    await db.query('ALTER TABLE installation_signals RENAME TO unavailable_signals');
    assert.equal((await fetch(base+'/observe',{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin})).status,204);
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='installation_claim'")).rows[0].n===2);
    await db.query('ALTER TABLE unavailable_signals RENAME TO installation_signals');
  } finally {
    await stop(); await new Promise<void>(resolve=>smtp.close(()=>resolve())); await browser.close(); await new Promise<void>(resolve=>site.close(()=>resolve())); await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
