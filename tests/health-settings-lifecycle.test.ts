import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { enableInstallation } from '../apps/installation.js';
import { optionalSchemas } from '../apps/optional-schema.js';
import { configureHealth, evaluateInactivity, deliverHealth, recordOperationalState, reconcileOperationalEpisode, recoverOperationalSource, maintainHealthHistory } from '../apps/health-alerts.js';

test('health configuration lifecycle suppresses obsolete pending mail without losing history', {timeout:30000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='health_settings_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let messages=0;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS'],onData(stream,_session,callback){
    stream.resume(); stream.on('end',()=>{messages++;callback();});
  }});
  const server=smtp.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  const episodes=async(project='one')=>(await db.query('SELECT e.*,d.attempts,d.sent_at,d.expired_at FROM health_episodes e JOIN health_delivery d ON d.episode_id=e.id WHERE e.project_id=$1 ORDER BY e.id',[project])).rows;
  const baseline=async(project='one')=>{
    await db.query(`INSERT INTO installation_last_signal(project_id,first_observed_at,last_observed_at,last_activity_at)
      VALUES($1,clock_timestamp()-interval '4 minutes',clock_timestamp()-interval '2 minutes',clock_timestamp())
      ON CONFLICT(project_id) DO UPDATE SET first_observed_at=excluded.first_observed_at,last_observed_at=excluded.last_observed_at,last_activity_at=excluded.last_activity_at`,[project]);
  };
  try {
    for(const f of ['003_projects','018_notification_budget','025_installation_signals','028_health_alerts']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    await db.query("ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
    await db.query(await readFile('infra/044_notification_lifecycle.sql','utf8'));
    assert.equal((await optionalSchemas(db)).health.state,'NOT_INSTALLED');
    await db.query(await readFile('infra/029_health_settings_history.sql','utf8'));
    assert.equal((await optionalSchemas(db)).health.state,'AVAILABLE');
    await db.query("INSERT INTO projects VALUES('one','One','http://one.test'),('two','Two','http://two.test')");
    for(const project of ['one','two']) {
      await enableInstallation(db,project); await configureHealth(db,project,true,60,true);
      await baseline(project); await evaluateInactivity(db,project);
    }
    const original=(await episodes())[0], other=await episodes('two');
    assert.equal(original.attempts,0); assert.equal(original.expired_at,null);
    // Failure after the settings write must roll back settings, audit and diagnosis.
    await db.query(`CREATE FUNCTION reject_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='INVALIDATED' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_invalidation BEFORE INSERT ON health_history FOR EACH ROW EXECUTE FUNCTION reject_invalidation()`);
    await assert.rejects(configureHealth(db,'one',true,86400,true),/test rollback/);
    assert.equal((await db.query("SELECT inactivity_seconds FROM installation_health_settings WHERE project_id='one'")).rows[0].inactivity_seconds,60);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_settings_history WHERE project_id='one'")).rows[0].n,1);
    assert.deepEqual((await episodes())[0],original);
    await db.query('DROP TRIGGER reject_invalidation ON health_history; DROP FUNCTION reject_invalidation()');

    // The preexisting project lock serializes config with evaluation and delivery.
    const blocker=await db.connect(); let pending:Promise<unknown>|undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext('one'),45)");
      pending=configureHealth(db,'one',true,86400,true);
      const deadline=Date.now()+5000; let waiting=false;
      do { waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=hashtext('one')::oid AND objid=45 AND NOT granted) AS waiting")).rows[0].waiting; } while(!waiting && Date.now()<deadline);
      assert.ok(waiting,'configuration waits on shared project lock');
      await deliverHealth(db,'one',port); assert.equal(messages,0);
      assert.deepEqual((await episodes())[0],original);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtext('one'),45)");
      blocker.release(); await pending;
    }
    await configureHealth(db,'one',true,86400,true);
    await deliverHealth(db,'one',port);
    assert.equal(messages,0,'60-second episode must not send after extending deadline to 24 hours');
    assert.ok((await episodes())[0].invalidated_at);
    assert.ok((await episodes())[0].expired_at);
    await evaluateInactivity(db,'one'); assert.equal((await episodes()).length,1);
    assert.deepEqual(await episodes('two'),other,'configuration transition is project scoped');

    await configureHealth(db,'one',true,60,true);
    await Promise.all([evaluateInactivity(db,'one'),evaluateInactivity(db,'one')]);
    assert.equal((await episodes()).length,2,'old invalidated episode does not block a valid new episode');
    await configureHealth(db,'one',false,60,true);
    await deliverHealth(db,'one',port); assert.equal(messages,0);
    await configureHealth(db,'one',true,60,true);
    await deliverHealth(db,'one',port); assert.equal(messages,0,'reenabling cannot resurrect pending mail');
    await Promise.all([evaluateInactivity(db,'one'),evaluateInactivity(db,'one')]);
    assert.equal((await episodes()).length,3);
    const current=await episodes();
    await configureHealth(db,'one',true,60,true);
    assert.deepEqual(await episodes(),current,'identical configuration preserves the current diagnosis');
    await deliverHealth(db,'one',port); assert.equal(messages,1);
    await deliverHealth(db,'one',port); assert.equal(messages,1,'new episode is delivered once');
    const rows=await episodes();
    assert.equal(rows[0].id,original.id); assert.ok(rows[1].invalidated_at); assert.ok(rows[2].sent_at);
    assert.deepEqual((await db.query('SELECT event FROM health_history WHERE episode_id=$1 ORDER BY id',[original.id])).rows.map(r=>r.event),['OPENED','INVALIDATED']);
    const history=(await db.query("SELECT previous_settings,current_settings FROM health_settings_history WHERE project_id='one' ORDER BY id")).rows;
    assert.deepEqual(history.map(r=>r.current_settings),[
      {enabled:true,inactivity_seconds:60,operational_enabled:true},
      {enabled:true,inactivity_seconds:86400,operational_enabled:true},
      {enabled:true,inactivity_seconds:60,operational_enabled:true},
      {enabled:false,inactivity_seconds:60,operational_enabled:true},
      {enabled:true,inactivity_seconds:60,operational_enabled:true}
    ]);
    assert.equal(history[0].previous_settings,null);
    for(let i=1;i<history.length;i++) assert.deepEqual(history[i].previous_settings,history[i-1].current_settings);

    // All three recovery entry points must suppress pending OPERATIONAL mail.
    await recordOperationalState(db,'one','direct','DATABASE_ERROR',true);
    await recordOperationalState(db,'one','direct','DATABASE_ERROR',false);
    const key=crypto.randomUUID(), opened=new Date(Date.now()-1000), recovered=new Date();
    await reconcileOperationalEpisode(db,'one','reconciled',key,opened,recovered);
    await reconcileOperationalEpisode(db,'one','reconciled',key,opened,recovered);
    await recordOperationalState(db,'one','restart','DATABASE_ERROR',true);
    await recoverOperationalSource(db,'one','restart',new Date());
    await deliverHealth(db,'one',port); assert.equal(messages,1,'recovered failures cannot send obsolete mail');
    assert.equal((await db.query("SELECT sum(d.attempts)::int n FROM health_delivery d JOIN health_episodes e ON e.id=d.episode_id WHERE e.project_id='one' AND e.kind='OPERATIONAL'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='one' AND kind='OPERATIONAL' AND recovered_at IS NOT NULL")).rows[0].n,3);
    await recordOperationalState(db,'one','direct','DATABASE_ERROR',true);
    await deliverHealth(db,'one',port); assert.equal(messages,2,'new active failure remains deliverable');
    await recordOperationalState(db,'one','disabled','DATABASE_ERROR',true);
    await configureHealth(db,'one',true,60,false);
    await configureHealth(db,'one',true,60,true);
    await deliverHealth(db,'one',port); assert.equal(messages,2,'operational reenabling cannot resurrect cancelled intentions');
    await recordOperationalState(db,'one','disabled','DATABASE_ERROR',false);
    await recordOperationalState(db,'one','disabled','DATABASE_ERROR',true);
    await deliverHealth(db,'one',port); assert.equal(messages,3);
  } finally {
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});

test('health audit upgrade snapshots existing settings and retains history by project', async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='health_upgrade_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    for(const f of ['003_projects','025_installation_signals','028_health_alerts']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    await db.query("ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
    await db.query(await readFile('infra/044_notification_lifecycle.sql','utf8'));
    await db.query("INSERT INTO projects VALUES('one','One','http://one.test'),('two','Two','http://two.test')");
    for(const project of ['one','two']) await enableInstallation(db,project);
    await db.query("INSERT INTO installation_health_settings(project_id,enabled,inactivity_seconds,operational_enabled) VALUES('one',true,60,true),('two',false,86400,false)");
    await db.query(await readFile('infra/029_health_settings_history.sql','utf8'));
    const snapshots=(await db.query('SELECT project_id,previous_settings,current_settings FROM health_settings_history ORDER BY project_id')).rows;
    assert.deepEqual(snapshots,[
      {project_id:'one',previous_settings:null,current_settings:{enabled:true,inactivity_seconds:60,operational_enabled:true}},
      {project_id:'two',previous_settings:null,current_settings:{enabled:false,inactivity_seconds:86400,operational_enabled:false}}
    ]);
    await db.query("UPDATE health_settings_history SET occurred_at=clock_timestamp()-interval '31 days'");
    await configureHealth(db,'one',true,86400,true);
    await maintainHealthHistory(db,'one');
    assert.equal((await db.query("SELECT count(*)::int n FROM health_settings_history WHERE project_id='one'")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_settings_history WHERE project_id='two'")).rows[0].n,1);
  } finally { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
});
