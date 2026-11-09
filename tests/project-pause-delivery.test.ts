import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { reconcileF27 } from '../apps/notification-intents.js';
import { cleanup } from '../apps/detection.js';
import { markDegradationGap, degradationState } from '../apps/degradation.js';
import { projectMaintenance } from '../apps/project-maintenance.js';
import { deliverOne } from '../apps/alerts.js';
import { deliverHealth, configureHealth, recordOperationalState } from '../apps/health-alerts.js';
import { enableInstallation } from '../apps/installation.js';
import { observe } from '../apps/detection.js';
import { managePages } from '../apps/protected-pages.js';
import { deliverCtaAlert } from '../apps/cta-delivery.js';

// All barriers are database locks or SMTP callbacks; no timing sleeps.
test('project pause: real maintenance, PostgreSQL admission and SMTP with isolated projects', {timeout:60000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='pause_delivery_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options,max:1});
  const messages:string[]=[];
  let messageObserver:((body:string)=>void)|undefined;
  let barrier: (()=>void)|undefined, reached:(()=>void)|undefined;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){
    let body=''; stream.on('data',chunk=>{body+=String(chunk);});
    stream.on('end',()=>{messages.push(body); messageObserver?.(body); if(reached) {const notify=reached; reached=undefined; barrier=()=>callback(); notify();} else callback();});
  }});
  const server=smtp.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address && typeof address!=='string');const port=address.port;
  const pause=()=>managePages(db,{project:'health',action:'pause-project'});
  const resume=()=>managePages(db,{project:'health',action:'resume-project'});
  const pending=async()=>(await db.query(`SELECT a.id,a.attempts,a.sent_at,a.expired_at,i.host FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='health' AND a.sent_at IS NULL ORDER BY a.id`)).rows;
  const health=async()=>(await db.query(`SELECT d.* FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id WHERE e.project_id='health' ORDER BY d.episode_id`)).rows;
  try {
    for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','011_cta_inventory','022_cta_capture_selection','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','025_installation_signals','026_degradation','027_canary_degradation','028_health_alerts','029_health_settings_history','033_clone_delivery_attempts']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    // This scenario needs no page policy infrastructure; it uses the real project admin control.
    await db.query("ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
    await db.query(await readFile('infra/044_notification_lifecycle.sql','utf8'));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('health','Health','http://health.test'),('finance','Finance','http://finance.test'),('outside','Outside','http://outside.test')");
    for(const id of ['health','finance']) {await enableInstallation(db,id);await configureHealth(db,id,false,60,true);}
    const maintenance=projectMaintenance(db,{SMTP_PORT:String(port)},'outside');
    for(const id of ['health','finance']) {
      await observe(db,id,`http://${id}.test`,`http://${id}-copy.test`);
      await recordOperationalState(db,id,'fixture_a','OPERATION_ERROR_UNKNOWN',true);
    }
    await maintenance();
    assert.equal(messages.length,4,'A: both projects perform real SMTP');
    await observe(db,'health','http://health.test','http://health-pending.test');
    await recordOperationalState(db,'health','fixture_b','OPERATION_ERROR_UNKNOWN',true);
    await db.query("INSERT INTO observations(project_id,host,observed_at) VALUES('health','expired.test',now()-interval '8 days'),('finance','expired.test',now()-interval '8 days'),('outside','expired.test',now()-interval '8 days')");
    const point=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('health',$1,'test','a')",[point]);
    await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('health',$1,'MARKER_COLLISION')",[point]);
    await reconcileF27(db,'health');
    // A real failed attempt is preserved, along with its attempt history.
    await deliverOne(db,'health',1);
    const before=await pending(), healthBefore=await health();
    assert.equal(before[0].attempts,1);
    await cleanup(db,'health');
    assert.equal((await db.query("SELECT count(*)::int n FROM observations WHERE host='expired.test' AND project_id='finance'")).rows[0].n,1,'project retention cannot touch finance');
    await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start) VALUES('health','degradation.test','POSSIBLE_DEGRADATION',now()-interval '1 hour')");
    const degradationBefore=(await db.query("SELECT * FROM degradation_audit WHERE project_id='health' ORDER BY observed_at")).rows;
    await pause(); // B: existing administrative project state transition.
    let count=messages.length;
    await Promise.all([maintenance(),deliverOne(other,'health',port),deliverHealth(other,'health',port),deliverCtaAlert(other,async()=>{assert.fail('paused CTA dispatch');})]);
    assert.equal(messages.length,count,'C/D: paused maintenance and dispatch admit no SMTP');
    assert.deepEqual(await pending(),before,'F: payload and previous attempts preserved');
    assert.deepEqual(await health(),healthBefore);
    await markDegradationGap(db,'health');
    assert.equal(await degradationState(db,'health','degradation.test'),'UNKNOWN');
    assert.deepEqual((await db.query("SELECT * FROM degradation_audit WHERE project_id='health' ORDER BY observed_at")).rows,degradationBefore,'C: no operational transition while paused');
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_collection_gaps WHERE project_id='health'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM notification_lifecycle_queue WHERE project_id='health' AND hold_state='SUSPENDED'")).rows[0].n,3);
    assert.equal((await db.query("SELECT count(*)::int n FROM observations WHERE host='expired.test' AND project_id IN ('health','finance')")).rows[0].n,0,'I: legitimate retention continues');
    assert.equal((await db.query("SELECT count(*)::int n FROM observations WHERE host='expired.test' AND project_id='outside'")).rows[0].n,1,'I: excluded project remains untouched');
    await db.query("UPDATE incidents SET first_seen=now()-interval '31 days',last_seen=now()-interval '31 days' WHERE project_id='health' AND host='health-pending.test'");
    await db.query("UPDATE health_episodes SET opened_at=now()-interval '31 days',recovered_at=now()-interval '31 days' WHERE project_id='health' AND source='fixture_b'");
    // Legacy PROJECT_ID health runs its real maintenance loop while paused.
    await db.query(`CREATE FUNCTION legacy_retention_barrier() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF OLD.project_id='health' THEN PERFORM pg_notify('legacy_retention','health'); END IF; RETURN OLD; END $body$;
      CREATE TRIGGER legacy_retention_barrier AFTER DELETE ON observations FOR EACH ROW EXECUTE FUNCTION legacy_retention_barrier()`);
    await db.query("INSERT INTO observations(project_id,host,observed_at) VALUES('health','legacy-expired.test',now()-interval '8 days')");
    await observe(db,'finance','http://finance.test','http://finance-legacy.test');
    const listener=await db.connect();
    await listener.query('LISTEN legacy_retention');
    const retained=once(listener,'notification');
    const financeMail=new Promise<void>(resolve=>{messageObserver=body=>{if(body.includes('finance-legacy.test')) resolve();};});
    const reserved=createServer().listen(0,'127.0.0.1');await once(reserved,'listening');
    const addr=reserved.address();assert.ok(addr && typeof addr!=='string');await new Promise<void>(resolve=>reserved.close(()=>resolve()));
    const legacy=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:options,PROJECT_ID:'health',PORT:String(addr.port),SMTP_PORT:String(port),GATEWAY_MODE:undefined,GATEWAY_TRANSPORT:'',PUBLIC_GATEWAY_HOST:'',ALLOWED_ORIGIN:'',LAB_CONTROLLED_ORIGIN:'',LAB_CONTROLLED_RISK:'',INFRASTRUCTURE_DNS_HOSTS:'',INFRASTRUCTURE_DNS_SERVER:''},stdio:['ignore','ignore','pipe']});
    let legacyLogs='';legacy.stderr?.on('data',chunk=>{legacyLogs+=String(chunk);});
    try {
      await Promise.race([Promise.all([retained,financeMail]),once(legacy,'exit').then(()=>{throw Error('legacy process exited before maintenance barriers: '+legacyLogs);})]);
      assert.equal(messages.length,count+1,'legacy paused health sends none; finance sends');
      assert.deepEqual(await pending(),before);
      assert.equal((await db.query("SELECT count(*)::int n FROM observations WHERE host='legacy-expired.test'")).rows[0].n,0);
    } finally {if(legacy.exitCode===null && legacy.signalCode===null) {legacy.kill();await once(legacy,'exit');}messageObserver=undefined;await listener.query('UNLISTEN *');listener.release();}
    await db.query('DROP TRIGGER legacy_retention_barrier ON observations; DROP FUNCTION legacy_retention_barrier()');
    count++;
    await observe(db,'finance','http://finance.test','http://finance-next.test');
    await recordOperationalState(db,'finance','fixture_b','OPERATION_ERROR_UNKNOWN',true);
    await maintenance();assert.equal(messages.length,count+2,'E: finance continues');
    await resume();
    await db.query("UPDATE alert_outbox a SET next_attempt=now()-interval '1 second' FROM incidents i WHERE i.id=a.incident_id AND i.project_id='health'");
    await Promise.all([maintenance(),deliverCtaAlert(db,async()=>{assert.fail('obsolete CTA dispatch');})]);
    assert.equal(messages.length,count+2,'G: no old queue burst');
    assert.equal((await db.query("SELECT count(*)::int n FROM notification_lifecycle_queue WHERE project_id='health' AND hold_state='REVIEW_REQUIRED'")).rows[0].n,3);
    assert.equal((await pending())[0].attempts,1);
    // H1: admitted SMTP holds no database locks; pause commits while SMTP is blocked.
    await observe(db,'health','http://health.test','http://health-admitted.test');
    const entered=new Promise<void>(resolve=>{reached=resolve;});
    const sending=deliverOne(other,'health',port);await entered;
    const writer=await db.connect();
    try {await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='500ms'");await writer.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='health'");await writer.query('COMMIT');} finally {await writer.query('ROLLBACK');writer.release();}
    await deliverOne(db,'health',port);assert.equal(messages.length,count+3);
    barrier!();barrier=undefined;await sending;
    assert.ok((await db.query("SELECT a.sent_at FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='health-admitted.test'")).rows[0].sent_at,'pre-pause admission may complete');
    // Health uses the same admission boundary, and leaves no PG lock in SMTP.
    await resume();
    await recordOperationalState(db,'health','fixture_c','OPERATION_ERROR_UNKNOWN',true);
    const senderPid=(await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const healthEntered=new Promise<void>(resolve=>{reached=resolve;});
    const healthSending=deliverHealth(other,'health',port);await healthEntered;
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype IN ('advisory','tuple','relation','transactionid')",[senderPid])).rows[0].n,0,'no PostgreSQL lock during SMTP');
    await pause();
    await deliverHealth(db,'health',port);
    barrier!();barrier=undefined;await healthSending;
    count++;
    await resume();
    // H2: pause owns row lock first. Real maintenance and dispatcher wait, then see PAUSED.
    await observe(db,'health','http://health.test','http://health-racing.test');
    const lock=await db.connect();
    try {
      await lock.query('BEGIN');await lock.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='health'");
      const dispatch=deliverOne(other,'health',port), sweep=maintenance();
      const deadline=Date.now()+5000;let waiting=false;
      do {waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT lifecycle_state FROM projects%') AS waiting")).rows[0].waiting;} while(!waiting && Date.now()<deadline);
      assert.ok(waiting,'dispatch waits for pause row lock');
      await lock.query('COMMIT');await Promise.all([dispatch,sweep]);
      assert.equal(messages.length,count+3);
    } finally {await lock.query('ROLLBACK');lock.release();}
    // J: genuine PostgreSQL privilege failure at admission, not a mocked gate.
    await resume();await observe(db,'health','http://health.test','http://health-db-failure.test');
    const role='pause_role_'+randomUUID().replaceAll('-','');
    await root.query(`CREATE ROLE ${role}`);
    const restricted=await other.connect();
    try {
      await root.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await restricted.query(`SET ROLE ${role}`);
      const single=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema} -c role=${role}`});
      try {await assert.rejects(deliverOne(single,'health',port),{code:'42501'});await assert.rejects(deliverHealth(single,'health',port),{code:'42501'});await assert.rejects(deliverCtaAlert(single,async()=>{assert.fail('unsafe send');}),{code:'42501'});} finally {await single.end();}
      assert.equal(messages.length,count+3);
    } finally {await restricted.query('RESET ROLE');restricted.release();await root.query(`DROP OWNED BY ${role}`);await root.query(`DROP ROLE ${role}`);}
    const unavailable=new Pool({host:'127.0.0.1',port:1,connectionTimeoutMillis:500});
    try {
      await assert.rejects(deliverOne(unavailable,'health',port));
      await assert.rejects(deliverHealth(unavailable,'health',port));
      await assert.rejects(deliverCtaAlert(unavailable,async()=>{assert.fail('database unavailable must not send');}));
    } finally {await unavailable.end();}
    assert.equal(messages.length,count+3,'J: real connection failure admits no SMTP');
    assert.equal((await db.query("SELECT count(*)::int n FROM clone_delivery_attempts d JOIN alert_outbox a ON a.id=d.outbox_id JOIN incidents i ON i.id=a.incident_id WHERE i.host IN ('health-racing.test','health-db-failure.test')")).rows[0].n,0);
  } finally {
    barrier?.();await new Promise<void>(resolve=>smtp.close(()=>resolve()));await db.end();await other.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
