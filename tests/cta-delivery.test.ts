import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { deliverCtaAlert } from '../apps/cta-delivery.js';
import { SMTPServer } from 'smtp-server';
import { sendLocalCtaAlert } from '../apps/cta-local-smtp.js';
import { cleanupCta } from '../apps/cta-inventory.js';
import { createServer, type Socket } from 'node:net';

test('CTA delivery is atomic, exclusive, bounded and recovers interrupted work', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL, options});
  for (const name of ['003_projects','011_cta_inventory','022_cta_capture_selection','014_cta_drift_alerts','015_cta_alert_deliveries'])
    await db.query((await readFile(`infra/${name}.sql`,'utf8')).replace(/^\uFEFF/,''));
  const project=`delivery_${randomUUID()}`, point=randomUUID();
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,`http://localhost/${project}`]);
  await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES($1,$2,'test','a')",[project,point]);
  let migrated=false;
  const insert=async () => {
    const id=(await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES($1,$2,'MARKER_COLLISION') RETURNING id",[project,point])).rows[0].id as string;
    if (migrated) await db.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1)',[id]);
    return id;
  };
  const state=async (id:string) => (await db.query('SELECT state,attempts FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rows[0];
  try {
    const history = [];
    for (const oldState of ['PENDING','PROCESSING','FAILED','DELIVERED']) {
      const id = await insert(); history.push(id);
      await db.query(`UPDATE cta_alert_deliveries SET state=$2, attempts=1,
        lease_token=CASE WHEN $2='PROCESSING' THEN $3::uuid ELSE NULL END,
        lease_until=CASE WHEN $2='PROCESSING' THEN now()-interval '1 minute' ELSE NULL END WHERE alert_id=$1`, [id,oldState,randomUUID()]);
    }
    await db.query(await readFile('infra/016_cta_local_smtp.sql','utf8'));
    await db.query(await readFile('infra/018_notification_budget.sql','utf8'));
    await db.query(await readFile('infra/020_cta_delivery_expiry.sql','utf8'));
    await db.query(await readFile('infra/021_notification_intent_reconciliation.sql','utf8')); migrated=true;
    assert.equal(await deliverCtaAlert(db, async()=>{ throw Error('history must not be sent'); }),false);
    const historical = await db.query('SELECT state,delivery_mode,result_kind FROM cta_alert_deliveries ORDER BY alert_id');
    assert.deepEqual(historical.rows, ['PENDING','PROCESSING','FAILED','DELIVERED'].map(s=>({state:s,delivery_mode:'SIMULATED',result_kind:s==='DELIVERED'?'SIMULATED':null})));
    await db.query('DELETE FROM cta_drift_alerts WHERE id=ANY($1::bigint[])',[history]);
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const id=(await client.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES($1,$2,'MARKER_COLLISION') RETURNING id",[project,point])).rows[0].id;
      await client.query('INSERT INTO cta_alert_deliveries(alert_id) VALUES($1)',[id]);
      assert.equal((await client.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rowCount,1);
      await client.query('ROLLBACK');
      assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rowCount,0);
    } finally { client.release(); }
    const id=await insert();
    let calls=0, release!:()=>void, started!:()=>void;
    const entered=new Promise<void>(r=>{started=r;}); const gate=new Promise<void>(r=>{release=r;});
    const first=deliverCtaAlert(db,async () => { calls++; started(); await gate; });
    await entered; assert.equal(await deliverCtaAlert(db, async()=>{}),false); release(); await first;
    assert.equal(calls,1); assert.deepEqual(await state(id),{state:'DELIVERED',attempts:1});
    const retry=await insert();
    await deliverCtaAlert(db,async()=>{throw Error('simulated');});
    assert.deepEqual(await state(retry),{state:'PENDING',attempts:1});
    assert.equal(await deliverCtaAlert(db, async()=>{}),false);
    await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()-interval '1 second' WHERE alert_id=$1",[retry]);
    await deliverCtaAlert(db, async()=>{});
    assert.deepEqual(await state(retry),{state:'DELIVERED',attempts:2});
    const exhausted=await insert();
    for (let i=0;i<3;i++) {
      await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()-interval '1 second' WHERE alert_id=$1",[exhausted]);
      await deliverCtaAlert(db,async()=>{throw Error('simulated');});
    }
    assert.deepEqual(await state(exhausted),{state:'FAILED',attempts:3});
    await db.query("UPDATE notification_attempt_budget SET reserved_at=now()-interval '61 minutes'");
    const stale=await insert();
    let releaseStale!:()=>void, startedStale!:()=>void;
    const staleGate=new Promise<void>(r=>{releaseStale=r;});
    const staleStarted=new Promise<void>(r=>{startedStale=r;});
    const oldAttempt=deliverCtaAlert(db,async()=>{startedStale(); await staleGate;});
    await staleStarted;
    await db.query("UPDATE cta_alert_deliveries SET lease_until=now()-interval '1 second' WHERE alert_id=$1",[stale]);
    let releaseNew!:()=>void, startedNew!:()=>void;
    const newGate=new Promise<void>(r=>{releaseNew=r;});
    const newStarted=new Promise<void>(r=>{startedNew=r;});
    const newAttempt=deliverCtaAlert(db,async()=>{startedNew(); await newGate;});
    await newStarted; releaseStale(); await oldAttempt;
    assert.deepEqual(await state(stale),{state:'PROCESSING',attempts:2});
    releaseNew(); await newAttempt;
    assert.deepEqual(await state(stale),{state:'DELIVERED',attempts:2});
    const interrupted=await insert();
    const env={...process.env,PGOPTIONS:options};
    const held=spawn(process.execPath,['dist/tests/fixtures/cta-delivery-hold.js'],{env,stdio:['ignore','pipe','inherit']});
    await once(held.stdout,'data');
    assert.deepEqual(await state(interrupted),{state:'PROCESSING',attempts:1});
    held.kill(); await once(held,'exit');
    await db.query("UPDATE cta_alert_deliveries SET lease_until=now()-interval '1 second' WHERE alert_id=$1",[interrupted]);
    const messages:string[]=[];
    const smtp = new SMTPServer({authOptional:true, disabledCommands:['AUTH','STARTTLS'], onData(stream, _session, callback) { let message=''; stream.on('data',chunk=>{message+=String(chunk);}); stream.on('end',()=>{messages.push(message); callback();}); }});
    await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));
    const address = smtp.server.address();
    assert.ok(address && typeof address !== 'string');
    const worker=spawn(process.execPath,['dist/apps/cta-delivery-worker.js'],{env:{...env,DATABASE_URL:process.env.TEST_DATABASE_URL,CTA_SMTP_LAB:'1',CTA_SMTP_LAB_PORT:String(address.port),SMTP_HOST:'external.invalid',SMTP_USER:'synthetic',SMTP_PASSWORD:'synthetic',HTTP_PROXY:'http://external.invalid:1'},stdio:'ignore'});
    try {
      for (let i=0;i<50 && (await state(interrupted)).state!=='DELIVERED';i++) await delay(100);
      assert.deepEqual(await state(interrupted),{state:'DELIVERED',attempts:2});
    } finally { worker.kill(); await once(worker,'exit'); }
    assert.equal((await db.query('SELECT result_kind FROM cta_alert_deliveries WHERE alert_id=$1',[interrupted])).rows[0].result_kind,'SMTP_LOCAL_ACCEPTED');
    await db.query("UPDATE notification_attempt_budget SET reserved_at=now()-interval '61 minutes'");
    const duplicate=await insert();
    await deliverCtaAlert(db,async id=>{await sendLocalCtaAlert(id,address.port); throw Error('interrupted after acceptance');});
    assert.deepEqual(await state(duplicate),{state:'PENDING',attempts:1});
    await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()-interval '1 second' WHERE alert_id=$1",[duplicate]);
    await deliverCtaAlert(db,id=>sendLocalCtaAlert(id,address.port));
    assert.deepEqual(await state(duplicate),{state:'DELIVERED',attempts:2});
    assert.equal(messages.filter(message=>message.includes(`<cta-alert-${duplicate}@example.test>`)).length,2);
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    await db.query("UPDATE notification_attempt_budget SET reserved_at=now()-interval '61 minutes'");
    const rejected=await insert();
    const rejectSmtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onRcptTo(_address,_session,cb){cb(Error('rejected'));}});
    await new Promise<void>(resolve=>rejectSmtp.listen(0,'127.0.0.1',resolve));
    const rejectAddr=rejectSmtp.server.address(); assert.ok(rejectAddr && typeof rejectAddr !== 'string');
    try { await deliverCtaAlert(db,id=>sendLocalCtaAlert(id,rejectAddr.port)); }
    finally { await new Promise<void>(resolve=>rejectSmtp.close(()=>resolve())); }
    assert.deepEqual(await state(rejected),{state:'PENDING',attempts:1});
    await db.query("UPDATE cta_alert_deliveries SET next_attempt=now()+interval '1 day' WHERE alert_id=$1",[rejected]);
    const timed=await insert(); let peer:Socket|undefined;
    const stalled=createServer(socket=>{peer=socket;});
    await new Promise<void>(resolve=>stalled.listen(0,'127.0.0.1',resolve));
    const stalledAddr=stalled.address(); assert.ok(stalledAddr && typeof stalledAddr !== 'string');
    try { await deliverCtaAlert(db,id=>sendLocalCtaAlert(id,stalledAddr.port)); }
    finally { peer?.destroy(); await new Promise<void>(resolve=>stalled.close(()=>resolve())); }
    assert.deepEqual(await state(timed),{state:'PENDING',attempts:1});
    await db.query("UPDATE cta_drift_alerts SET created_at=now()-interval '31 days' WHERE project_id=$1",[project]);
    await cleanupCta(db);
    assert.equal((await db.query('SELECT 1 FROM cta_alert_deliveries WHERE alert_id=$1',[interrupted])).rowCount,0);
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  } catch (error) { await db.end().catch(()=>{}); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
});
