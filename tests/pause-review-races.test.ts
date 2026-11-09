import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { collectInfrastructure, type DnsResolver } from '../apps/infrastructure-dns.js';
import { deliverCtaAlert } from '../apps/cta-delivery.js';
import { sendLocalCtaAlert } from '../apps/cta-local-smtp.js';
import { managePages } from '../apps/protected-pages.js';

async function fixture() {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='review_race_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema} -c lock_timeout=500`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options,max:1,connectionTimeoutMillis:1000});
  const other=new Pool({connectionString:process.env.TEST_DATABASE_URL,options,max:1});
  for(const f of ['001_initial','002_alerts','003_projects','011_cta_inventory','022_cta_capture_selection','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','030_infrastructure_dns']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
  await db.query("ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
  await db.query(await readFile('infra/044_notification_lifecycle.sql','utf8'));
  await db.query("INSERT INTO projects(id,name,origin) VALUES('health','Health','http://health.test'),('finance','Finance','http://finance.test')");
  return {db,other,close:async()=>{await db.end();await other.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}};
}

test('DNS external barrier releases project and connection; pause commits before resolver completes', {timeout:10000}, async()=>{
  const {db,other,close}=await fixture();
  const host='copy.owner-domain.com';
  let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const resolver:DnsResolver={resolve4:async()=>{entered();await gate;return ['8.8.8.8'];},resolve6:async()=>[],resolveCname:async()=>[],resolveNs:async()=>[]};
  let collecting:Promise<boolean>|undefined;
  try {
    await db.query('INSERT INTO incidents(project_id,host) VALUES($1,$2)',['health',host]);
    collecting=collectInfrastructure(db,'health',host,[host],resolver,'controlled-test-resolver');
    await started;
    // max:1 proves the resolver is not retaining a checked-out PoolClient.
    assert.equal((await db.query('SELECT 1 AS available')).rows[0].available,1);
    await managePages(other,{project:'health',action:'pause-project'});
    assert.equal((await other.query("SELECT lifecycle_state FROM projects WHERE id='health'")).rows[0].lifecycle_state,'PAUSED');
    release();assert.equal(await collecting,false);
    assert.equal((await db.query('SELECT count(*)::int n FROM infrastructure_dns_observations')).rows[0].n,0);
    await managePages(db,{project:'health',action:'resume-project'});
    // Incident disappearing while DNS resolves cannot be replaced by a different one.
    let enteredAgain!:()=>void, releaseAgain!:()=>void;
    const startedAgain=new Promise<void>(resolve=>{enteredAgain=resolve;});const gateAgain=new Promise<void>(resolve=>{releaseAgain=resolve;});
    resolver.resolve4=async()=>{enteredAgain();await gateAgain;return ['8.8.8.8'];};
    collecting=collectInfrastructure(db,'health',host,[host],resolver,'controlled-test-resolver');
    await startedAgain;await other.query('DELETE FROM incidents WHERE project_id=$1 AND host=$2',['health',host]);
    releaseAgain();assert.equal(await collecting,false);
  } finally {release();await collecting;await close();}
});

test('CTA expired lease never takes over live SMTP callback, including pause and resume', {timeout:15000}, async()=>{
  const {db,other,close}=await fixture();
  let release:(()=>void)|undefined, entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});let sends=0;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){stream.resume();stream.on('end',()=>{sends++;release=()=>callback();entered();});}});
  const server=smtp.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address && typeof address!=='string');
  let sending:Promise<boolean>|undefined;
  try {
    const point=randomUUID();await db.query("INSERT INTO cta_points(project_id,id,surface,kind) VALUES('health',$1,'test','a')",[point]);
    const id=(await db.query("INSERT INTO cta_drift_alerts(project_id,point_id,reason) VALUES('health',$1,'MARKER_COLLISION') RETURNING id",[point])).rows[0].id;
    sending=deliverCtaAlert(db,id=>sendLocalCtaAlert(id,address.port));await started;
    const before=(await other.query('SELECT * FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rows[0];
    await other.query("UPDATE cta_alert_deliveries SET lease_until=now()-interval '1 second' WHERE alert_id=$1",[id]);
    assert.equal(await deliverCtaAlert(other,async()=>{assert.fail('concurrent duplicate SMTP');}),false);
    let current=(await other.query('SELECT * FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rows[0];
    assert.equal(current.state,'PROCESSING');assert.equal(current.attempts,1);assert.equal(current.lease_token,before.lease_token);
    await managePages(other,{project:'health',action:'pause-project'});
    assert.equal(await deliverCtaAlert(other,async()=>{assert.fail('SMTP admitted after pause');}),false);
    await managePages(other,{project:'health',action:'resume-project'});
    assert.equal(await deliverCtaAlert(other,async()=>{assert.fail('automatic backlog replay');}),false);
    assert.equal((await other.query('SELECT hold_state FROM notification_lifecycle_queue WHERE queue=$1 AND item_id=$2',['CTA',String(id)])).rows[0].hold_state,'REVIEW_REQUIRED');
    release!();release=undefined;assert.equal(await sending,true);
    current=(await other.query('SELECT * FROM cta_alert_deliveries WHERE alert_id=$1',[id])).rows[0];
    assert.equal(current.state,'DELIVERED');assert.equal(current.attempts,1);assert.equal(current.lease_token,null);assert.equal(sends,1);
  } finally {release?.();await sending;await new Promise<void>(resolve=>smtp.close(()=>resolve()));await close();}
});
