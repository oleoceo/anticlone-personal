import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { OptionalSchema, optionalSchemas } from '../apps/optional-schema.js';

// Deterministic retry timing: errors remain visible, and failures never mean migration absence.
test('optional schema gate: absence is cached; real faults back off, recover and redact', async () => {
  const logs:string[]=[]; let now=0, calls=0;
  const absent=new OptionalSchema('test',false,line=>logs.push(line),()=>now);
  for(let i=0;i<100;i++) await absent.run('maintenance',async()=>{calls++;});
  assert.equal(calls,0); assert.equal(logs.length,1); assert.equal(absent.state,'NOT_INSTALLED');
  const present=new OptionalSchema('test',true,line=>logs.push(line),()=>now);
  assert.equal(await present.run('maintenance',async()=>{calls++;throw {code:'42501',message:'secret database connection'};}),false);
  assert.equal(present.state,'DATABASE_ERROR');
  for(let i=0;i<100;i++) await present.run('correlation',async()=>{calls++;});
  assert.equal(calls,1); assert.equal(logs.length,2); assert.match(logs[1],/DATABASE_ERROR code=42501/);
  assert.ok(!logs.join().includes('secret'));
  now=60_000;
  assert.equal(await present.run('maintenance',async()=>{calls++;}),true);
  assert.equal(present.state,'AVAILABLE'); assert.equal(calls,2); assert.match(logs[2],/recovered/);
  const fault=new Error('connection down');
  await assert.rejects(optionalSchemas({query:async()=>{throw fault;}} as unknown as Pick<Pool,'query'>),error=>error===fault);
  let finish!:()=>void;
  const pending=present.run('claim',()=>new Promise<void>(resolve=>{finish=resolve;}));
  await present.run('retention',async()=>{throw {code:'42P01'};});
  finish(); await pending;
  assert.equal(present.state,'DATABASE_ERROR','concurrent success cannot hide a fault');
});

for(const migrations of [[],['025_installation_signals'],['026_degradation'],['025_installation_signals','026_degradation']]) {
  test(`real gateway legacy compatibility and maintenance: ${migrations.join('+')||'pre-025'}`,{timeout:30000},async()=>{
    assert.ok(process.env.TEST_DATABASE_URL);
    const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    const schema='legacy_'+crypto.randomUUID().replaceAll('-','');
    await root.query(`CREATE SCHEMA ${schema}`);
    const options=`-c search_path=${schema}`;
    const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    const reserve=createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
    const addr=reserve.address(); assert.ok(addr && typeof addr!=='string');
    await new Promise<void>(resolve=>reserve.close(()=>resolve()));
    const base=`http://127.0.0.1:${addr.port}`, primary='http://localhost:12345', copy='http://127.0.0.1:12346';
    let child:ReturnType<typeof spawn>|undefined, logs='';
    const installed=migrations.includes('025_installation_signals'), degradation=migrations.includes('026_degradation');
    const until=async(fn:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('timeout: '+logs);};
    try {
      for(const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry',...migrations]) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
      await db.query("INSERT INTO projects VALUES('one','One',$1),('two','Two',$2)",[primary,'http://other.test']);
      // Existing maintenance must continue even when the optional schemas are missing.
      await db.query("INSERT INTO observations(project_id,host,observed_at) VALUES('one','expired.test',now()-interval '8 days')");
      if(installed){
        await db.query("INSERT INTO installations(project_id,id,origin) VALUES('one',$1,$2),('two',$3,'http://other.test')",[crypto.randomUUID(),primary,crypto.randomUUID()]);
        await db.query("INSERT INTO installation_signals VALUES('one','core',now()-interval '8 days'),('two','core',now()-interval '8 days')");
      }
      if(degradation){
        await db.query("INSERT INTO degradation_events(project_id,host,source,bucket,observed_at) VALUES('one','old.test','core',now()-interval '2 days',now()-interval '2 days'),('two','old.test','core',now()-interval '2 days',now()-interval '2 days')");
        await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start,observed_at) VALUES('one','old.test','UNKNOWN',now()-interval '8 days',now()-interval '8 days')");
      }
      child=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'one',PORT:String(addr.port),SMTP_PORT:'1',LAB_CONTROLLED_ORIGIN:copy,LAB_CONTROLLED_RISK:'',ALLOWED_ORIGIN:'',GATEWAY_MODE:undefined,GATEWAY_TRANSPORT:'',PUBLIC_GATEWAY_HOST:''},stdio:['ignore','ignore','pipe']});
      child.stderr?.on('data',chunk=>{logs+=String(chunk);});
      await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
      await until(async()=>(await db.query("SELECT count(*)::int n FROM observations WHERE host='expired.test'")).rows[0].n===0);
      if(installed){
        await until(async()=>(await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='one'")).rows[0].n===0);
        assert.equal((await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='two'")).rows[0].n,1);
      }
      if(degradation){
        assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='one'")).rows[0].n,0);
        assert.equal((await db.query("SELECT count(*)::int n FROM degradation_audit WHERE project_id='one'")).rows[0].n,0);
        assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='two'")).rows[0].n,1);
      }
      for(let i=0;i<3;i++) {
        for(const origin of [primary,copy]) for(const endpoint of ['/observe','/observe/fallback']){
          assert.equal((await fetch(base+endpoint,{method:'POST',headers:{origin,'content-type':'text/plain'},body:origin})).status,204);
        }
        await new Promise(r=>setTimeout(r,1050)); // multiple actual maintenance ticks, not just startup
      }
      if(installed)assert.equal((await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='one'")).rows[0].n,2);
      if(degradation)assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='one'")).rows[0].n,2);
      assert.equal(logs.split('installation NOT_INSTALLED').length-1,installed?0:1);
      assert.equal(logs.split('degradation NOT_INSTALLED').length-1,degradation?0:1);
      assert.doesNotMatch(logs,/unavailable|DATABASE_ERROR|maintenance failed/);
      if(degradation){
        // Unexpected schema loss after discovery is a real DB fault, not NOT_INSTALLED.
        await db.query('ALTER TABLE degradation_events RENAME TO temporarily_unavailable_events');
        await until(async()=>logs.includes('DATABASE_ERROR code=42P01'));
        for(let i=0;i<3;i++)assert.equal((await fetch(base+'/observe/fallback',{method:'POST',headers:{origin:copy,'content-type':'text/plain'},body:copy})).status,204);
        await new Promise(r=>setTimeout(r,2200));
        assert.equal(logs.split('DATABASE_ERROR').length-1,1,'one fault report, no retry every second');
        assert.match(logs,/degradation maintenance DATABASE_ERROR code=42P01/);
        assert.doesNotMatch(logs,/maintenance failed/);
        assert.equal((await fetch(base+'/healthz')).status,200,'previous capabilities remain operational');
      }
    } finally {
      if(child && child.exitCode===null){child.kill();await once(child,'exit');}
      await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
    }
  });
}
