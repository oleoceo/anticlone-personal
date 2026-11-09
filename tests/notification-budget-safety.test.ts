import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { deliverCtaAlert } from '../apps/cta-delivery.js';
import { deliverOne } from '../apps/alerts.js';

async function fixture() {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  for (const file of ['001_initial','002_alerts','003_projects','011_cta_inventory','022_cta_capture_selection','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry'])
    await db.query((await readFile(`infra/${file}.sql`,'utf8')).replace(/^\uFEFF/,''));
  await db.query("INSERT INTO projects(id,name,origin) VALUES('p','p','http://localhost')");
  const point=randomUUID();
  await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('p',$1,'test','a')",[point]);
  await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) SELECT 'p',$1,'MARKER_COLLISION' FROM generate_series(1,4)",[point]);
  await db.query(await readFile('infra/021_notification_intent_reconciliation.sql','utf8'));
  await db.query("INSERT INTO incidents(project_id,host) VALUES('p','owned.test')");
  await db.query('INSERT INTO alert_outbox(incident_id) SELECT id FROM incidents');
  return {db, close:async()=>{await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();}};
}

test('exhausted CTA leases retain unknown transport outcomes during saturated budget backoff, with bounded polling', async t => {
  const {db,close}=await fixture();
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  try {
    await db.query("INSERT INTO notification_attempt_budget(reserved_at) SELECT clock_timestamp() FROM generate_series(1,10)");
    const ids=(await db.query('SELECT alert_id FROM cta_alert_deliveries ORDER BY alert_id')).rows.map(r=>r.alert_id);
    await db.query(`UPDATE cta_alert_deliveries SET state='PROCESSING', attempts=3, lease_token=$1,
      lease_until=now()-interval '1 second' WHERE alert_id=ANY($2::bigint[])`,[randomUUID(),ids.slice(0,3)]);
    await db.query("UPDATE cta_alert_deliveries SET delivery_mode='SIMULATED' WHERE alert_id=$1",[ids[1]]);
    await db.query("UPDATE cta_alert_deliveries SET lease_until=now()+interval '1 minute' WHERE alert_id=$1",[ids[2]]);
    let sends=0;
    assert.equal(await deliverCtaAlert(db,async()=>{sends++;}),false);
    const unknown=(await db.query('SELECT state,attempts,lease_token,lease_until FROM cta_alert_deliveries WHERE alert_id=$1',[ids[0]])).rows[0];
    assert.equal(unknown.state,'PROCESSING');assert.equal(unknown.attempts,3);assert.ok(unknown.lease_token);assert.ok(unknown.lease_until);
    await db.query("UPDATE cta_alert_deliveries SET lease_until=now()-interval '1 second' WHERE alert_id=$1",[ids[2]]);
    // Detect any maintenance query during rapid polling: budget is already cached as blocked.
    await db.query(`CREATE FUNCTION reject_sweep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'excessive sweep'; END $$`);
    await db.query('CREATE TRIGGER reject_sweep BEFORE UPDATE ON cta_alert_deliveries FOR EACH STATEMENT EXECUTE FUNCTION reject_sweep()');
    for(let i=0;i<20;i++) assert.equal(await deliverCtaAlert(db,async()=>{sends++;}),false);
    await db.query('DROP TRIGGER reject_sweep ON cta_alert_deliveries');
    now+=60_001;
    assert.equal(await deliverCtaAlert(db,async()=>{sends++;}),false);
    assert.equal((await db.query('SELECT state FROM cta_alert_deliveries WHERE alert_id=$1',[ids[2]])).rows[0].state,'PROCESSING');
    assert.equal((await db.query('SELECT state FROM cta_alert_deliveries WHERE alert_id=$1',[ids[1]])).rows[0].state,'PROCESSING');
    assert.equal((await db.query('SELECT attempts FROM cta_alert_deliveries WHERE alert_id=$1',[ids[3]])).rows[0].attempts,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,10);
    assert.equal(sends,0);
  } finally {await close();}
});

test('missing budget singleton rejects both reservation paths without changing attempts or recreating control', async () => {
  const {db,close}=await fixture();
  try {
    await db.query('DELETE FROM notification_budget_lock');
    let sends=0;
    for(const saturated of [false,true]) {
      if(saturated) await db.query("INSERT INTO notification_attempt_budget(reserved_at) SELECT clock_timestamp() FROM generate_series(1,10)");
      await assert.rejects(deliverCtaAlert(db,async()=>{sends++;}),/budget control is missing/);
      await assert.rejects(deliverOne(db,'p',1),/budget control is missing/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_budget_lock')).rows[0].n,0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,saturated?10:0);
      assert.equal((await db.query('SELECT sum(attempts)::int AS n FROM cta_alert_deliveries')).rows[0].n,0);
      assert.equal((await db.query('SELECT sum(attempts)::int AS n FROM alert_outbox')).rows[0].n,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM cta_alert_deliveries WHERE state<>'PENDING' OR lease_token IS NOT NULL OR lease_until IS NOT NULL")).rows[0].n,0);
    }
    assert.equal(sends,0);
  } finally {await close();}
});
