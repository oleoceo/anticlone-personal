import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { deliverCtaAlert } from '../apps/cta-delivery.js';

test('CTA delivery is atomic, exclusive, bounded and recovers interrupted work', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL, options});
  for (const name of ['003_projects','011_cta_inventory','014_cta_drift_alerts','015_cta_alert_deliveries'])
    await db.query((await readFile(`infra/${name}.sql`,'utf8')).replace(/^\uFEFF/,''));
  const project=`delivery_${randomUUID()}`, point=randomUUID();
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,`http://localhost/${project}`]);
  await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES($1,$2,'test','a')",[project,point]);
  const insert=async () => (await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES($1,$2,'MARKER_COLLISION') RETURNING id",[project,point])).rows[0].id as string;
  const state=async (id:string) => (await db.query('SELECT state,attempts FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rows[0];
  try {
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const id=(await client.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES($1,$2,'MARKER_COLLISION') RETURNING id",[project,point])).rows[0].id;
      assert.equal((await client.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rowCount,1);
      await client.query('ROLLBACK');
      assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rowCount,0);
    } finally { client.release(); }
    await db.query(`CREATE FUNCTION reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`);
    await db.query('CREATE TRIGGER reject_delivery BEFORE INSERT ON cta_alert_deliveries FOR EACH ROW EXECUTE FUNCTION reject_delivery()');
    await assert.rejects(insert());
    assert.equal((await db.query('SELECT 1 FROM cta_drift_alerts WHERE project_id=$1',[project])).rowCount,0);
    await db.query('DROP TRIGGER reject_delivery ON cta_alert_deliveries');
    const id=await insert();
    let calls=0, release!:()=>void, started!:()=>void;
    const entered=new Promise<void>(r=>{started=r;}); const gate=new Promise<void>(r=>{release=r;});
    const first=deliverCtaAlert(db,async () => { calls++; started(); await gate; });
    await entered; assert.equal(await deliverCtaAlert(db),false); release(); await first;
    assert.equal(calls,1); assert.deepEqual(await state(id),{state:'DELIVERED',attempts:1});
    const retry=await insert();
    await deliverCtaAlert(db,async()=>{throw Error('simulated');});
    assert.deepEqual(await state(retry),{state:'PENDING',attempts:1});
    assert.equal(await deliverCtaAlert(db),false);
    await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()-interval '1 second' WHERE alert_id=$1",[retry]);
    await deliverCtaAlert(db);
    assert.deepEqual(await state(retry),{state:'DELIVERED',attempts:2});
    const exhausted=await insert();
    for (let i=0;i<3;i++) {
      await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()-interval '1 second' WHERE alert_id=$1",[exhausted]);
      await deliverCtaAlert(db,async()=>{throw Error('simulated');});
    }
    assert.deepEqual(await state(exhausted),{state:'FAILED',attempts:3});
    const interrupted=await insert();
    const env={...process.env,PGOPTIONS:options};
    const held=spawn(process.execPath,['dist/tests/fixtures/cta-delivery-hold.js'],{env,stdio:['ignore','pipe','inherit']});
    await once(held.stdout,'data');
    assert.deepEqual(await state(interrupted),{state:'PROCESSING',attempts:1});
    held.kill(); await once(held,'exit');
    await db.query("UPDATE cta_alert_deliveries SET lease_until=now()-interval '1 second' WHERE alert_id=$1",[interrupted]);
    const worker=spawn(process.execPath,['dist/apps/cta-delivery-worker.js'],{env:{...env,DATABASE_URL:process.env.TEST_DATABASE_URL},stdio:'ignore'});
    try {
      for (let i=0;i<50 && (await state(interrupted)).state!=='DELIVERED';i++) await delay(100);
      assert.deepEqual(await state(interrupted),{state:'DELIVERED',attempts:2});
    } finally { worker.kill(); await once(worker,'exit'); }
    await db.query('DELETE FROM cta_drift_alerts WHERE project_id=$1',[project]);
    assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[interrupted])).rowCount,0);
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  } catch (error) { await db.end().catch(()=>{}); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
});
