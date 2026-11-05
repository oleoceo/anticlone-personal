import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { observe } from '../apps/detection.js';
import { importInventory } from '../apps/cta-inventory.js';
import { deliverOne } from '../apps/alerts.js';
import { deliverCtaAlert } from '../apps/cta-delivery.js';
import { reconcileF26, reconcileF27 } from '../apps/notification-intents.js';

test('notification intent failures preserve events and reconciliation survives restart and saturation', async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  try {
    for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','011_cta_inventory','022_cta_capture_selection','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry'])
      await db.query((await readFile(`infra/${file}.sql`,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('p','p','http://localhost')");
    const oldPoint=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('p',$1,'old','a')",[oldPoint]);
    await db.query("INSERT INTO cta_observations(project_id,point_id,evidence,confidence) VALUES('p',$1,'historical','LOW')",[oldPoint]);
    const historical=(await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('p',$1,'MARKER_COLLISION') RETURNING id",[oldPoint])).rows[0].id;
    await db.query("UPDATE cta_alert_deliveries SET delivery_mode='SIMULATED' WHERE alert_id=$1",[historical]);
    const orphan=(await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('p',$1,'MARKER_COLLISION') RETURNING id",[oldPoint])).rows[0].id;
    await db.query('DELETE FROM cta_alert_deliveries WHERE alert_id=$1',[orphan]);
    await assert.rejects(db.query(await readFile('infra/021_notification_intent_reconciliation.sql','utf8')),/historical CTA alerts without delivery/);
    // Migration has an explicit transaction: roll it back before retrying.
    await db.query('ROLLBACK');
    await db.query('DELETE FROM cta_drift_alerts WHERE id=$1',[orphan]);
    await db.query(await readFile('infra/021_notification_intent_reconciliation.sql','utf8'));
    await db.query(`CREATE FUNCTION reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='injected'; END $$`);
    await db.query('CREATE TRIGGER reject_outbox BEFORE INSERT ON alert_outbox FOR EACH ROW EXECUTE FUNCTION reject_intent()');
    assert.equal(await observe(db,'p','http://localhost','https://clone.test'),'observed');
    assert.equal((await db.query("SELECT 1 FROM incidents WHERE host='clone.test'")).rowCount,1);
    assert.equal((await db.query("SELECT 1 FROM observations WHERE host='clone.test'")).rowCount,1);
    assert.equal((await db.query('SELECT 1 FROM alert_outbox')).rowCount,0);
    await db.query('DROP TRIGGER reject_outbox ON alert_outbox');
    await db.query("UPDATE incidents SET first_seen=clock_timestamp()-interval '25 hours' WHERE host='clone.test'");
    await observe(db,'p','http://localhost','https://clone.test');
    assert.equal((await db.query("SELECT expired_at IS NOT NULL AS expired FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='clone.test'")).rows[0].expired,true);
    await db.query('DELETE FROM alert_outbox');

    const point=randomUUID(), destination=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('p',$1,'landing','marker001','a','offer')",[point]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES('p','offer',$1,'http://localhost/approved')",[destination]);
    await db.query("INSERT INTO cta_mappings(project_id,point_id,offer,destination_id) VALUES('p',$1,'offer',$2)",[point,destination]);
    await db.query("INSERT INTO cta_observations(project_id,point_id,evidence,confidence,observed_url) VALUES('p',$1,'fixture','HIGH','http://localhost/old')",[point]);
    await db.query('CREATE TRIGGER reject_delivery BEFORE INSERT ON cta_alert_deliveries FOR EACH ROW EXECUTE FUNCTION reject_intent()');
    const candidate={marker:'marker001',kind:'a',parent:'div',ordinal:1,url:'http://localhost/new'};
    await importInventory(db,'p',{surface:'landing',candidates:[candidate]});
    assert.equal((await db.query("SELECT 1 FROM cta_drift_alerts WHERE reason='DESTINATION_CHANGED'")).rowCount,1);
    assert.equal((await db.query('SELECT review_required FROM cta_points WHERE id=$1',[point])).rows[0].review_required,true);
    assert.equal((await db.query("SELECT 1 FROM cta_observations WHERE observed_url='http://localhost/new'")).rowCount,1);
    await db.query('UPDATE cta_points SET review_required=false WHERE id=$1',[point]);
    await importInventory(db,'p',{surface:'landing',candidates:[candidate,candidate]});
    assert.equal((await db.query("SELECT 1 FROM cta_drift_alerts WHERE reason='MARKER_COLLISION' AND point_id=$1",[point])).rowCount,1);
    assert.equal((await db.query('SELECT review_required FROM cta_points WHERE id=$1',[point])).rows[0].review_required,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM cta_observations WHERE point_id<>$1 AND evidence<>'historical'",[point])).rows[0].n,2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_alert_deliveries')).rows[0].n,1);
    await db.query('DROP TRIGGER reject_delivery ON cta_alert_deliveries');

    // Infrastructure errors must reject the operation with no persisted success.
    for (const code of ['53100','53200','53300']) {
      await db.query(`CREATE OR REPLACE FUNCTION reject_infrastructure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}', MESSAGE='injected'; END $$`);
      await db.query('CREATE TRIGGER reject_infrastructure BEFORE INSERT ON alert_outbox FOR EACH ROW EXECUTE FUNCTION reject_infrastructure()');
      const host=`infrastructure-${code}.test`;
      await assert.rejects(observe(db,'p','http://localhost',`https://${host}`), {code});
      assert.equal((await db.query('SELECT 1 FROM incidents WHERE host=$1',[host])).rowCount,0);
      assert.equal((await db.query('SELECT 1 FROM observations WHERE host=$1',[host])).rowCount,0);
      await db.query('DROP TRIGGER reject_infrastructure ON alert_outbox');

      await db.query('UPDATE cta_points SET review_required=false WHERE id=$1',[point]);
      const beforeAlerts=(await db.query('SELECT id FROM cta_drift_alerts ORDER BY id')).rows;
      const beforeDeliveries=(await db.query('SELECT alert_id FROM cta_alert_deliveries ORDER BY alert_id')).rows;
      await db.query('CREATE TRIGGER reject_infrastructure BEFORE INSERT ON cta_alert_deliveries FOR EACH ROW EXECUTE FUNCTION reject_infrastructure()');
      const url=`http://localhost/infrastructure-${code}`;
      await assert.rejects(importInventory(db,'p',{surface:'landing',candidates:[{...candidate,url}]}), {code});
      assert.equal((await db.query('SELECT review_required FROM cta_points WHERE id=$1',[point])).rows[0].review_required,false);
      assert.equal((await db.query('SELECT 1 FROM cta_observations WHERE observed_url=$1',[url])).rowCount,0);
      assert.deepEqual((await db.query('SELECT id FROM cta_drift_alerts ORDER BY id')).rows,beforeAlerts);
      assert.deepEqual((await db.query('SELECT alert_id FROM cta_alert_deliveries ORDER BY alert_id')).rows,beforeDeliveries);
      await db.query('DROP TRIGGER reject_infrastructure ON cta_alert_deliveries');
    }

    await db.query(`CREATE FUNCTION reject_fatal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='fatal'; END $$`);
    await db.query('CREATE TRIGGER reject_fatal BEFORE INSERT ON alert_outbox FOR EACH ROW EXECUTE FUNCTION reject_fatal()');
    await assert.rejects(observe(db,'p','http://localhost','https://fatal.test'));
    assert.equal((await db.query("SELECT 1 FROM incidents WHERE host='fatal.test'")).rowCount,0);
    await db.query('DROP TRIGGER reject_fatal ON alert_outbox');
    await db.query('UPDATE cta_points SET review_required=false WHERE id=$1',[point]);
    await db.query('CREATE TRIGGER reject_fatal BEFORE INSERT ON cta_alert_deliveries FOR EACH ROW EXECUTE FUNCTION reject_fatal()');
    await assert.rejects(importInventory(db,'p',{surface:'landing',candidates:[{...candidate,url:'http://localhost/fatal'}]}));
    assert.equal((await db.query('SELECT review_required FROM cta_points WHERE id=$1',[point])).rows[0].review_required,false);
    assert.equal((await db.query("SELECT 1 FROM cta_observations WHERE observed_url='http://localhost/fatal'")).rowCount,0);
    await db.query('DROP TRIGGER reject_fatal ON cta_alert_deliveries');
    await db.query(`CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON incidents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_fatal()`);
    await assert.rejects(observe(db,'p','http://localhost','https://commit.test'));
    assert.equal((await db.query("SELECT 1 FROM incidents WHERE host='commit.test'")).rowCount,0);
    await db.query('DROP TRIGGER reject_commit ON incidents');

    await db.query("UPDATE incidents SET first_seen=clock_timestamp()-interval '25 hours' WHERE host='clone.test'");
    await db.query("UPDATE cta_drift_alerts SET created_at=clock_timestamp()-interval '25 hours' WHERE reason='DESTINATION_CHANGED'");
    await db.query("INSERT INTO incidents(project_id,host) VALUES('p','recent.test')");
    await db.query("INSERT INTO notification_attempt_budget(reserved_at) SELECT clock_timestamp() FROM generate_series(1,10)");
    const restarted=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try {
      await Promise.all([deliverOne(restarted,'p',1),deliverCtaAlert(restarted,async()=>{throw Error('must not send');}),reconcileF26(other,'p'),reconcileF27(other)]);
      await Promise.all([reconcileF26(db,'p'),reconcileF27(db)]);
    } finally { await restarted.end(); }
    assert.deepEqual((await db.query('SELECT i.host,a.expired_at IS NOT NULL AS expired,a.attempts FROM incidents i JOIN alert_outbox a ON a.incident_id=i.id ORDER BY i.host')).rows,
      [{host:'clone.test',expired:true,attempts:0},{host:'recent.test',expired:false,attempts:0}]);
    assert.deepEqual((await db.query('SELECT a.reason,d.state,d.delivery_mode,d.attempts FROM cta_drift_alerts a JOIN cta_alert_deliveries d ON d.alert_id=a.id WHERE a.id<>$1 ORDER BY a.id',[historical])).rows,
      [{reason:'DESTINATION_CHANGED',state:'EXPIRED',delivery_mode:'SMTP_LOCAL',attempts:0},{reason:'MARKER_COLLISION',state:'PENDING',delivery_mode:'SMTP_LOCAL',attempts:0}]);
    assert.equal((await db.query('SELECT delivery_mode FROM cta_alert_deliveries WHERE alert_id=$1',[historical])).rows[0].delivery_mode,'SIMULATED');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,10);

    let now=Date.now(); t.mock.method(Date,'now',()=>now);
    await db.query("INSERT INTO incidents(project_id,host) VALUES('p','deferred.test')");
    await db.query('CREATE TRIGGER reject_outbox BEFORE INSERT ON alert_outbox FOR EACH ROW EXECUTE FUNCTION reject_intent()');
    const backoff=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try {
      await assert.rejects(deliverOne(backoff,'p',1));
      await deliverOne(backoff,'p',1);
      assert.equal((await db.query("SELECT 1 FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='deferred.test'")).rowCount,0);
      await db.query('DROP TRIGGER reject_outbox ON alert_outbox');
      now+=60_001; await deliverOne(backoff,'p',1);
      assert.equal((await db.query("SELECT 1 FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='deferred.test'")).rowCount,1);
    } finally { await backoff.end(); }
    const deferred=(await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('p',$1,'MARKER_COLLISION') RETURNING id",[point])).rows[0].id;
    await db.query('CREATE TRIGGER reject_delivery BEFORE INSERT ON cta_alert_deliveries FOR EACH ROW EXECUTE FUNCTION reject_intent()');
    const ctaBackoff=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try {
      await assert.rejects(deliverCtaAlert(ctaBackoff,async()=>{throw Error('must not send');}));
      assert.equal(await deliverCtaAlert(ctaBackoff,async()=>{throw Error('must not send');}),false);
      assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[deferred])).rowCount,0);
      await db.query('DROP TRIGGER reject_delivery ON cta_alert_deliveries');
      now+=60_001; await deliverCtaAlert(ctaBackoff,async()=>{throw Error('must not send');});
      assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[deferred])).rowCount,1);
    } finally { await ctaBackoff.end(); }
  } finally { await db.end(); await other.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
