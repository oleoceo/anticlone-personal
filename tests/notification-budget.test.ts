import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { deliverOne } from '../apps/alerts.js';
import { deliverCtaAlert } from '../apps/cta-delivery.js';

test('shared rolling budget is atomic across F26 and F27 and survives new pools', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  try {
    for (const file of ['001_initial','002_alerts','003_projects','011_cta_inventory','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget'])
      await db.query((await readFile(`infra/${file}.sql`,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('p','p','http://localhost')");
    const point=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('p',$1,'test','a')",[point]);
    await db.query("INSERT INTO incidents(project_id,host) SELECT 'p','host'||n||'.test' FROM generate_series(1,12) n");
    await db.query('INSERT INTO alert_outbox(incident_id) SELECT id FROM incidents');
    await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) SELECT 'p',$1,'MARKER_COLLISION' FROM generate_series(1,12)",[point]);
    await deliverOne(db,'p',1);
    await deliverCtaAlert(db,async()=>{});
    const run = (mode:string) => new Promise<void>((resolve,reject) => {
      const child=spawn(process.execPath,['dist/tests/fixtures/notification-budget-process.js',mode,'1'],{env:{...process.env,PGOPTIONS:options},stdio:'inherit'});
      child.once('error',reject); child.once('exit',code=>code===0 ? resolve() : reject(Error('child failed: '+code)));
    });
    await Promise.all(Array.from({length:16},(_,i)=>run(i%2?'f26':'f27')));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,10);
    const f26=(await db.query('SELECT sum(attempts)::int AS n FROM alert_outbox')).rows[0].n;
    const f27=(await db.query('SELECT sum(attempts)::int AS n FROM cta_alert_deliveries')).rows[0].n;
    assert.equal(f26+f27,10); assert.ok(f26>0 && f27>0);
    const fresh=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try {
      await deliverCtaAlert(fresh,async()=>{throw Error('must not send');});
      assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_attempt_budget')).rows[0].n,10);
      await db.query("UPDATE notification_attempt_budget SET reserved_at=clock_timestamp()-interval '61 minutes' WHERE id=(SELECT min(id) FROM notification_attempt_budget)");
      const resumed=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
      try { assert.equal(await deliverCtaAlert(resumed,async()=>{throw Error('uncertain');}),true); }
      finally { await resumed.end(); }
      assert.equal((await db.query("SELECT count(*)::int AS n FROM notification_attempt_budget WHERE reserved_at > clock_timestamp()-interval '60 minutes'")).rows[0].n,10);
    } finally { await fresh.end(); }
    await db.query("UPDATE notification_attempt_budget SET reserved_at=clock_timestamp()-interval '61 minutes'");
    await db.query("CREATE FUNCTION reject_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$");
    await db.query('CREATE TRIGGER reject_budget BEFORE INSERT ON notification_attempt_budget FOR EACH ROW EXECUTE FUNCTION reject_budget()');
    const before=(await db.query('SELECT sum(attempts)::int AS n FROM cta_alert_deliveries')).rows[0].n;
    const rollbackPool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try { await assert.rejects(deliverCtaAlert(rollbackPool,async()=>{throw Error('must not send');})); }
    finally { await rollbackPool.end(); }
    assert.equal((await db.query('SELECT sum(attempts)::int AS n FROM cta_alert_deliveries')).rows[0].n,before);
    await db.query('DROP TRIGGER reject_budget ON notification_attempt_budget');
    await db.query("UPDATE alert_outbox SET next_attempt=now()+interval '1 day'");
    const crashId=(await db.query('SELECT id FROM alert_outbox WHERE attempts=0 ORDER BY id LIMIT 1')).rows[0].id;
    await db.query("UPDATE alert_outbox SET next_attempt=now() WHERE id=$1",[crashId]);
    const server=createServer();
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address(); assert.ok(address && typeof address!=='string');
    const connected=once(server,'connection');
    const child=spawn(process.execPath,['dist/tests/fixtures/notification-budget-process.js','f26',String(address.port)],{env:{...process.env,PGOPTIONS:options},stdio:'inherit'});
    const [socket]=await connected;
    child.kill(); await once(child,'exit'); socket.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    assert.equal((await db.query('SELECT attempts FROM alert_outbox WHERE id=$1',[crashId])).rows[0].attempts,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM notification_attempt_budget WHERE reserved_at > clock_timestamp()-interval '60 minutes'")).rows[0].n,1);
    await db.query("UPDATE notification_attempt_budget SET reserved_at=clock_timestamp()-interval '61 minutes'");
    await db.query("UPDATE alert_outbox SET next_attempt=now()-interval '1 second' WHERE attempts=0");
    await db.query("UPDATE notification_attempt_budget SET reserved_at=clock_timestamp()-interval '61 minutes'");
    const attempts=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
    try {
      const id=(await db.query('SELECT id FROM alert_outbox WHERE attempts=0 ORDER BY id LIMIT 1')).rows[0].id;
      for(let i=0;i<3;i++) { await db.query("UPDATE alert_outbox SET next_attempt=now()-interval '1 second' WHERE id=$1",[id]); await deliverOne(attempts,'p',1); }
      const row=(await db.query('SELECT attempts,sent_at FROM alert_outbox WHERE id=$1',[id])).rows[0];
      assert.equal(row.attempts,3); assert.equal(row.sent_at,null);
      await db.query("UPDATE alert_outbox SET next_attempt=now()-interval '1 second' WHERE id=$1",[id]);
      await deliverOne(attempts,'p',1);
      assert.equal((await db.query('SELECT attempts FROM alert_outbox WHERE id=$1',[id])).rows[0].attempts,3);
    } finally { await attempts.end(); }
  } finally { await db.end(); await other.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
