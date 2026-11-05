import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { deliverOne } from '../apps/alerts.js';
import { deliverCtaAlert } from '../apps/cta-delivery.js';
import { observe } from '../apps/detection.js';

test('expiry preserves events, respects active delivery and survives workers and saturation', {timeout:30000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  try {
    for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','011_cta_inventory','022_cta_capture_selection','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry'])
      await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('p','p','http://localhost')");
    const point=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('p',$1,'test','a')",[point]);
    await db.query("INSERT INTO incidents(project_id,host,first_seen) VALUES('p','old.test',clock_timestamp()-interval '24 hours'),('p','recent.test',clock_timestamp())");
    await db.query('INSERT INTO alert_outbox(incident_id) SELECT id FROM incidents');
    await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason,created_at) SELECT 'p',$1,'MARKER_COLLISION',clock_timestamp()-interval '24 hours' FROM generate_series(1,6)",[point]);
    const ids=(await db.query('SELECT alert_id FROM cta_alert_deliveries ORDER BY alert_id')).rows.map(r=>r.alert_id);
    await db.query("UPDATE cta_alert_deliveries SET delivery_mode='SIMULATED' WHERE alert_id=$1",[ids[1]]);
    await db.query("UPDATE cta_alert_deliveries SET state='PROCESSING',attempts=1,lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE alert_id=$1",[ids[2],randomUUID()]);
    await db.query("UPDATE cta_alert_deliveries SET state='PROCESSING',attempts=1,lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE alert_id=$1",[ids[3],randomUUID()]);
    await db.query("UPDATE cta_alert_deliveries SET state='FAILED' WHERE alert_id=$1",[ids[4]]);
    await db.query("UPDATE cta_alert_deliveries SET state='DELIVERED',result_kind='SMTP_LOCAL_ACCEPTED' WHERE alert_id=$1",[ids[5]]);
    await db.query(await readFile('infra/021_notification_intent_reconciliation.sql','utf8'));
    await db.query("INSERT INTO notification_attempt_budget(reserved_at) SELECT clock_timestamp() FROM generate_series(1,10)");
    let sends=0;
    await Promise.all([deliverOne(db,'p',1),deliverOne(other,'p',1),deliverCtaAlert(db,async()=>{sends++;}),deliverCtaAlert(other,async()=>{sends++;})]);
    const outbox=await db.query('SELECT i.host,a.expired_at IS NOT NULL AS expired,a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id ORDER BY i.host');
    assert.deepEqual(outbox.rows,[{host:'old.test',expired:true,attempts:0},{host:'recent.test',expired:false,attempts:0}]);
    assert.deepEqual((await db.query('SELECT state FROM cta_alert_deliveries ORDER BY alert_id')).rows.map(r=>r.state),['EXPIRED','PENDING','EXPIRED','PROCESSING','FAILED','DELIVERED']);
    assert.equal(sends,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,10);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_drift_alerts')).rows[0].n,6);
    await observe(db,'p','http://localhost','https://old.test');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='old.test' AND a.expired_at IS NOT NULL")).rows[0].n,1);
    await db.query("UPDATE cta_alert_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE alert_id=$1",[ids[3]]);
    // A new pool represents a restarted worker and has no maintenance/backoff cache.
    const restarted=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try { await deliverCtaAlert(restarted,async()=>{sends++;}); await deliverOne(restarted,'p',1); } finally { await restarted.end(); }
    assert.equal((await db.query('SELECT state FROM cta_alert_deliveries WHERE alert_id=$1',[ids[3]])).rows[0].state,'EXPIRED');
    await db.query('DELETE FROM notification_attempt_budget');
    // Hold the budget lock while both reservation paths wait; make the events old
    // before releasing it. Neither worker may reserve or invoke its sender.
    await db.query("INSERT INTO projects(id,name,origin) VALUES('boundary','boundary','http://boundary.localhost')");
    await db.query("INSERT INTO incidents(project_id,host) VALUES('boundary','boundary.test')");
    await db.query("INSERT INTO alert_outbox(incident_id) SELECT id FROM incidents WHERE project_id='boundary'");
    await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('p',$1,'MARKER_COLLISION')",[point]);
    const boundary=(await db.query('SELECT max(id) AS id FROM cta_drift_alerts')).rows[0].id;
    await db.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1)',[boundary]);
    const waiting=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    const lock=await db.connect();
    try {
      await lock.query('BEGIN'); await lock.query('SELECT singleton FROM notification_budget_lock FOR UPDATE');
      const f26=deliverOne(waiting,'boundary',1);
      const f27=deliverCtaAlert(waiting,async()=>{sends++;});
      await db.query("UPDATE incidents SET first_seen=clock_timestamp()-interval '24 hours' WHERE project_id='boundary'");
      await db.query("UPDATE cta_drift_alerts SET created_at=clock_timestamp()-interval '24 hours' WHERE id=$1",[boundary]);
      await lock.query('COMMIT'); await Promise.all([f26,f27]);
      assert.equal((await db.query("SELECT attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='boundary'")).rows[0].attempts,0);
      assert.equal((await db.query('SELECT attempts FROM cta_alert_deliveries WHERE alert_id=$1',[boundary])).rows[0].attempts,0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,0);
    } finally {lock.release(); await waiting.end();}
    let entered!:()=>void, release!:()=>void;
    const started=new Promise<void>(r=>{entered=r;}); const gate=new Promise<void>(r=>{release=r;});
    const senderPool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,cb){stream.resume();stream.on('end',()=>{entered();void gate.then(()=>cb());});}});
    await new Promise<void>(r=>smtp.listen(0,'127.0.0.1',r));
    const address=smtp.server.address(); assert.ok(address && typeof address!=='string');
    try {
      const sending=deliverOne(senderPool,'p',address.port); await started;
      await db.query("UPDATE incidents SET first_seen=clock_timestamp()-interval '24 hours' WHERE host='recent.test'");
      await deliverOne(db,'p',address.port);
      assert.equal((await db.query("SELECT expired_at FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='recent.test'")).rows[0].expired_at,null);
      release(); await sending;
      assert.ok((await db.query("SELECT sent_at FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='recent.test'")).rows[0].sent_at);
    } finally {release(); await new Promise<void>(r=>smtp.close(()=>r())); await senderPool.end();}
  } finally {await db.end(); await other.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();}
});
