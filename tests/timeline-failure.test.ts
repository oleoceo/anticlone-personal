import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { observe } from '../apps/detection.js';
import { degradationState } from '../apps/degradation.js';
import { collectInfrastructure } from '../apps/infrastructure-dns.js';

test('timeline INSERT failure preserves primary records and recovery', async (t) => {
  const diagnostics: string[]=[];
  t.mock.method(process.stderr,'write',(message: string) => {diagnostics.push(String(message)); return true;});
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='timeline_fault_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const count=async(table:string)=>Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  try {
    for(const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','026_degradation','030_infrastructure_dns','031_investigation_timeline']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query("CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'private diagnostic must not be logged'; END; $fault$");
    // AFTER INSERT also verifies that the inserted row cannot survive recovery.
    await db.query('CREATE TRIGGER fail_timeline AFTER INSERT ON investigation_timeline FOR EACH ROW EXECUTE FUNCTION fail_insert()');
    assert.equal(await observe(db,'a','https://original.test','https://copy.publicdomain.com'),'observed');
    assert.equal(await observe(db,'a','https://original.test','https://copy.publicdomain.com','fallback'),'observed');
    assert.equal(await count('incidents'),1);
    assert.equal(await count('observations'),2);
    assert.equal(await count('observation_source_days'),2);
    assert.equal(await count('alert_outbox'),1);
    await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start,observed_at) VALUES('a','copy.publicdomain.com','POSSIBLE_DEGRADATION',now(),now()-interval '1 minute')");
    assert.equal(await degradationState(db,'a','copy.publicdomain.com'),'UNKNOWN');
    assert.equal(await count('degradation_audit'),2);
    let address='8.8.8.8';
    const resolver={resolve4:async()=>[address],resolve6:async()=>[],resolveCname:async()=>[],resolveNs:async()=>[]};
    const collect=()=>collectInfrastructure(db,'a','copy.publicdomain.com',['copy.publicdomain.com'],resolver,'controlled-test-resolver');
    const age=()=>db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours'");
    assert.equal(await collect(),true);
    await age(); address='1.1.1.1';
    assert.equal(await collect(),true);
    assert.equal(await count('infrastructure_dns_observations'),8);
    assert.equal(await count('investigation_timeline'),0);
    assert.equal(diagnostics.length,4);
    assert.ok(diagnostics.every(message=>message==='Investigation timeline event unavailable; history may be incomplete\n'));
    await db.query('DROP TRIGGER fail_timeline ON investigation_timeline');
    await observe(db,'b','https://original.test','https://copy.publicdomain.com');
    await age(); address='9.9.9.9'; assert.equal(await collect(),true);
    await db.query("INSERT INTO degradation_audit(project_id,host,state,window_start,observed_at) VALUES('a','recovered.test','POSSIBLE_DEGRADATION',now(),now()-interval '1 minute')");
    assert.equal(await degradationState(db,'a','recovered.test'),'UNKNOWN');
    assert.deepEqual((await db.query('SELECT event_type FROM investigation_timeline ORDER BY id')).rows.map(r=>r.event_type),['first_observation','dns_change','degradation_transition']);
    // A later primary failure must roll back a successful timeline INSERT too.
    await db.query("CREATE TRIGGER fail_primary BEFORE INSERT ON infrastructure_dns_observations FOR EACH ROW WHEN (NEW.record_type = 'AAAA') EXECUTE FUNCTION fail_insert()");
    await age(); address='8.8.4.4';
    await assert.rejects(collect(),/private diagnostic/);
    assert.equal(await count('infrastructure_dns_observations'),12);
    assert.equal(await count('investigation_timeline'),3);
    await db.query('CREATE TRIGGER fail_observation BEFORE INSERT ON observations FOR EACH ROW EXECUTE FUNCTION fail_insert()');
    await assert.rejects(observe(db,'a','https://original.test','https://primary-failure.test'),/private diagnostic/);
    assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE host='primary-failure.test'")).rows[0].n,0);
    await db.query('CREATE TRIGGER fail_degradation BEFORE INSERT ON degradation_audit FOR EACH ROW EXECUTE FUNCTION fail_insert()');
    await assert.rejects(degradationState(db,'a','primary-failure.test'),/private diagnostic/);
  } finally {await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();}
});
