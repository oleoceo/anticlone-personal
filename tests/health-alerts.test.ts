import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { enableInstallation, disableInstallation, recordInstallationClaim } from '../apps/installation.js';
import { configureHealth, evaluateInactivity, deliverHealth, recordOperationalState, reconcileOperationalEpisode, recoverOperationalSource, maintainHealthHistory, recordInstallationActivity } from '../apps/health-alerts.js';

test('health episodes, deduplication, retries and recovery', {timeout:30000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='health_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let reject=true, messages=0;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS'],onData(stream, _session, callback) {
    stream.resume(); stream.on('end',()=>{ if (reject) callback(new Error('local failure')); else { messages++; callback(); } });
  }});
  const server=smtp.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=(smtp.server.address() as AddressInfo).port;
  try {
    for (const f of ['003_projects','018_notification_budget','025_installation_signals','028_health_alerts','029_health_settings_history']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    await db.query("INSERT INTO projects VALUES('one','One','http://owner.test'),('two','Two','http://two.test')");
    await enableInstallation(db,'one'); await enableInstallation(db,'two');
    await configureHealth(db,'one',true,60,true); await configureHealth(db,'two',false,60,false);
    await evaluateInactivity(db,'one');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM health_episodes')).rows[0].n,0);
    await recordInstallationClaim(db,'one','http://owner.test','core');
    await evaluateInactivity(db,'one');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM health_episodes')).rows[0].n,0);
    // A single old claim is not a baseline, even when it is older than the deadline.
    await db.query("UPDATE installation_last_signal SET first_observed_at=clock_timestamp()-interval '8 days',last_observed_at=clock_timestamp()-interval '8 days' WHERE project_id='one'");
    await evaluateInactivity(db,'one');
    assert.equal((await db.query('SELECT count(*)::int n FROM health_episodes')).rows[0].n,0);
    await disableInstallation(db,'one'); await enableInstallation(db,'one');
    assert.equal((await db.query("SELECT first_observed_at FROM installation_last_signal WHERE project_id='one'")).rows[0].first_observed_at,null);
    await db.query("UPDATE installation_last_signal SET first_observed_at=clock_timestamp()-interval '9 days',last_observed_at=clock_timestamp()-interval '8 days' WHERE project_id='one'");
    await db.query("DELETE FROM installation_signals WHERE project_id='one'");
    await evaluateInactivity(db,'one');
    assert.equal((await db.query('SELECT count(*)::int n FROM health_episodes')).rows[0].n,0,'no alert from absence of traffic');
    await recordInstallationActivity(db,'one','http://owner.test');

    const blocker=await db.connect();
    try {
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await blocker.query('SELECT pg_advisory_lock(45001,$1)',[pid]);
      await db.query(`CREATE FUNCTION hold_health_episode() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN PERFORM pg_advisory_xact_lock(45001,${pid}); RETURN NEW; END $body$;
        CREATE TRIGGER hold_health_episode BEFORE INSERT ON health_episodes FOR EACH ROW EXECUTE FUNCTION hold_health_episode()`);
      let current=true;
      const pending=evaluateInactivity(db,'one',()=>current);
      const deadline=Date.now()+5000; let waiting=false;
      do { waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=45001 AND objid=$1 AND NOT granted) AS waiting",[pid])).rows[0].waiting; } while(!waiting && Date.now()<deadline);
      assert.ok(waiting); current=false;
      await blocker.query('SELECT pg_advisory_unlock(45001,$1)',[pid]);
      await pending;
      assert.equal((await db.query('SELECT count(*)::int n FROM health_episodes')).rows[0].n,0);
      await db.query('DROP TRIGGER hold_health_episode ON health_episodes; DROP FUNCTION hold_health_episode()');
    } finally { blocker.release(); }
    await Promise.all([evaluateInactivity(db,'one'),evaluateInactivity(db,'one')]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM health_episodes')).rows[0].n,1);
    // Hold the shared budget row while a known collection gap invalidates this attempt.
    const budgetBlocker=await db.connect();
    try {
      await budgetBlocker.query('BEGIN');
      await budgetBlocker.query('SELECT singleton FROM notification_budget_lock FOR UPDATE');
      let current=true;
      const pending=deliverHealth(db,'one',port,()=>current);
      const deadline=Date.now()+5000; let waiting=false;
      do { waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%notification_budget_lock%') AS waiting")).rows[0].waiting; } while(!waiting && Date.now()<deadline);
      assert.ok(waiting); current=false;
      await budgetBlocker.query('COMMIT'); await pending;
      assert.equal((await db.query('SELECT attempts FROM health_delivery')).rows[0].attempts,0);
    } finally { budgetBlocker.release(); }
    await deliverHealth(db,'one',port);
    assert.deepEqual((await db.query('SELECT event FROM health_history ORDER BY id')).rows.map(r=>r.event),['OPENED','ATTEMPT','FAILED_UNCERTAIN']);
    await deliverHealth(db,'one',port);
    assert.equal((await db.query('SELECT attempts FROM health_delivery')).rows[0].attempts,1);
    let delay=(await db.query('SELECT extract(epoch FROM next_attempt-clock_timestamp()) AS seconds FROM health_delivery')).rows[0].seconds;
    assert.ok(Number(delay)>50 && Number(delay)<=60);
    await db.query("UPDATE health_delivery SET next_attempt=clock_timestamp()-interval '1 second'");
    await deliverHealth(db,'one',port);
    delay=(await db.query('SELECT extract(epoch FROM next_attempt-clock_timestamp()) AS seconds FROM health_delivery')).rows[0].seconds;
    assert.ok(Number(delay)>110 && Number(delay)<=120);
    await db.query("UPDATE health_delivery SET next_attempt=clock_timestamp()-interval '1 second'");
    reject=false; await deliverHealth(db,'one',port); assert.equal(messages,1);
    await recordInstallationClaim(db,'one','http://owner.test','core');
    await evaluateInactivity(db,'one');
    assert.ok((await db.query('SELECT recovered_at FROM health_episodes')).rows[0].recovered_at);
    await db.query("UPDATE installation_last_signal SET last_observed_at=clock_timestamp()-interval '2 minutes' WHERE project_id='one'");
    await evaluateInactivity(db,'one'); await evaluateInactivity(db,'two');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM health_episodes')).rows[0].n,2);
    await db.query("UPDATE installation_last_signal SET first_observed_at=NULL WHERE project_id='one'");
    await recordInstallationClaim(db,'one','http://owner.test','fallback');
    await deliverHealth(db,'one',port);
    assert.equal((await db.query('SELECT attempts FROM health_delivery ORDER BY episode_id DESC LIMIT 1')).rows[0].attempts,0);
    await evaluateInactivity(db,'one');
    assert.ok((await db.query("SELECT recovered_at FROM health_episodes WHERE kind='INACTIVE' ORDER BY id DESC LIMIT 1")).rows[0].recovered_at);
    await recordOperationalState(db,'one','maintenance','MAINTENANCE_ERROR',true);
    await recordOperationalState(db,'one','maintenance','MAINTENANCE_ERROR',true);
    await recordOperationalState(db,'one','maintenance','MAINTENANCE_ERROR',false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM health_episodes WHERE kind='OPERATIONAL' AND recovered_at IS NOT NULL")).rows[0].n,1);
    const key=crypto.randomUUID(), openedAt=new Date(Date.now()-5000), recoveredAt=new Date();
    await reconcileOperationalEpisode(db,'one','database',key,openedAt,recoveredAt);
    await reconcileOperationalEpisode(db,'one','database',key,openedAt,recoveredAt);
    assert.equal((await db.query('SELECT count(*)::int n FROM health_episodes WHERE observation_key=$1',[key])).rows[0].n,1);
    assert.deepEqual((await db.query('SELECT event FROM health_history WHERE episode_id=(SELECT id FROM health_episodes WHERE observation_key=$1) ORDER BY id',[key])).rows.map(r=>r.event),['OPENED','RECOVERED']);
    const before=await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='restart_claim'");
    const first=crypto.randomUUID(), second=crypto.randomUUID();
    await Promise.all([reconcileOperationalEpisode(db,'one','restart_claim',first,new Date()),reconcileOperationalEpisode(db,'one','restart_claim',second,new Date())]);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='restart_claim'")).rows[0].n,before.rows[0].n+1);
    await recoverOperationalSource(db,'one','restart_claim',new Date(Date.now()+1000));
    await reconcileOperationalEpisode(db,'one','restart_claim',crypto.randomUUID(),new Date());
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='restart_claim'")).rows[0].n,before.rows[0].n+2);
    await db.query("UPDATE health_operational_keys SET created_at=clock_timestamp()-interval '31 days' WHERE observation_key=$1",[first]);
    await maintainHealthHistory(db,'one');
    assert.equal((await db.query('SELECT count(*)::int n FROM health_operational_keys WHERE observation_key=$1',[first])).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='restart_claim'")).rows[0].n,before.rows[0].n+2);
    // Roll back the optional migration in dependency order; old claims still work.
    await db.query('DROP TRIGGER remember_installation_signal ON installation_signals; DROP FUNCTION remember_installation_signal(); DROP TRIGGER invalidate_health_baseline ON installations; DROP FUNCTION invalidate_health_baseline(); DROP TABLE health_settings_history,health_history,health_delivery,health_operational_keys,health_episodes,installation_last_signal,installation_health_settings');
    await recordInstallationClaim(db,'one','http://owner.test','fallback');
    assert.equal((await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='one' AND source='fallback'")).rows[0].n,1);
  } finally {
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
