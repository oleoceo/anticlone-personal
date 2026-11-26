import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { configuredOrigin, hostFromUrl, observe, cleanup, incidentCapacity } from '../apps/detection.js';
test('validates URLs and stores only normalized hostname', () => {
  assert.equal(hostFromUrl('https://EXAMPLE.test/private?q=secret'), 'example.test');
  assert.equal(configuredOrigin('https://example.test:8443/'), 'https://example.test:8443');
  assert.throws(() => configuredOrigin('https://example.test/path'));
  for (const value of ['file:///tmp/a', 'https://user:pass@example.test', 'invalid']) assert.throws(() => hostFromUrl(value));
});
test('real postgres: distinct clone hosts retain independent deduplicated intents after reconnect', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to an isolated PostgreSQL test database');
  let pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const project = 'test_' + crypto.randomUUID();
  const original = 'https://original.test';
  const hosts = ['clone-a.test', 'clone-b.test'];
  try {
    for (const file of ['001_initial', '002_alerts', '004_observation_sources', '005_canaries', '019_alert_outbox_expiry'])
      await pool.query(await readFile(`infra/${file}.sql`, 'utf8'));
    assert.equal(await observe(pool, project, original, original), 'authorized');
    assert.equal((await pool.query('SELECT id FROM incidents WHERE project_id=$1', [project])).rowCount, 0);
    for (const host of [hosts[0], hosts[0], hosts[1], hosts[1], hosts[0]]) {
      assert.equal(await observe(pool, project, original, `https://${host}`), 'observed');
    }
    const check = async () => {
      const rows = await pool.query(`SELECT i.host, count(a.id)::int AS intents FROM incidents i
        LEFT JOIN alert_outbox a ON a.incident_id=i.id WHERE i.project_id=$1 GROUP BY i.id, i.host ORDER BY i.host`, [project]);
      assert.deepEqual(rows.rows, hosts.map(host => ({host, intents: 1})));
    };
    await check();
    await pool.end(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await check();
    assert.equal(await observe(pool, project, original, `https://${hosts[1]}`), 'observed');
    await check();
  } finally {
    await pool.query('DELETE FROM observation_source_days WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM observation_days WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM observations WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM incidents WHERE project_id=$1', [project]);
    await pool.end();
  }
});
test('real postgres: original, repeated simulated clone and reconnect', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to an isolated PostgreSQL test database');
  let pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(await readFile('infra/001_initial.sql', 'utf8'));
  await pool.query(await readFile('infra/002_alerts.sql', 'utf8')); await pool.query(await readFile('infra/004_observation_sources.sql', 'utf8')); await pool.query(await readFile('infra/005_canaries.sql', 'utf8'));
  await pool.query(await readFile('infra/019_alert_outbox_expiry.sql', 'utf8'));
  const project = 'test_' + crypto.randomUUID();
  try {
    assert.equal(await observe(pool, project, 'https://original.test', 'https://original.test/'), 'authorized');
    assert.equal(await observe(pool, project, 'https://original.test', 'https://clone.test'), 'observed');
    await observe(pool, project, 'https://original.test', 'https://clone.test');
    await pool.end(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const incidents = await pool.query('SELECT host, status FROM incidents WHERE project_id=$1', [project]);
    const observations = await pool.query('SELECT host, source FROM observations WHERE project_id=$1', [project]);
    assert.deepEqual(incidents.rows, [{host:'clone.test', status:'unverified'}]); assert.equal(observations.rowCount, 1);
    assert.ok(observations.rows.every(row => row.host === 'clone.test' && row.source === 'core'));
    await pool.query("INSERT INTO incidents(project_id,host) SELECT $1, 'host-' || n || '.test' FROM generate_series(1,89) n", [project]);
    assert.equal(await observe(pool, project, 'https://original.test', 'https://overflow.test'), 'capacity');
    assert.equal(await observe(pool, project, 'https://original.test', 'https://clone.test'), 'observed');
  } finally {
    await pool.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]);
      await pool.query('DELETE FROM observation_days WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM observations WHERE project_id=$1', [project]); await pool.query('DELETE FROM incidents WHERE project_id=$1', [project]); await pool.end();
  }
});

test('reserved incident capacity preserves a first alert and deduplicates concurrent normal observations', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,connectionTimeoutMillis:1000});
  const project = 'reserve_' + crypto.randomUUID();
  try {
    for (const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','019_alert_outbox_expiry'])
      await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query("INSERT INTO incidents(project_id,host) SELECT $1, 'fixture-' || n || '.test' FROM generate_series(1,90) n",[project]);
    const {recordObservation}=await import('../apps/detection.js');
    const admit=async () => {
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        const result=await recordObservation(client,project,'https://confirmed-fixture.test','core',undefined,async()=>true);
        await client.query('COMMIT');
        return result;
      } catch(error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {client.release();}
    };
    assert.deepEqual(await Promise.all([admit(),admit()]),['observed','observed']);
    const {rows:[row]}=await db.query(`SELECT i.status,count(DISTINCT a.id)::int AS alerts,count(DISTINCT o.id)::int AS observations
      FROM incidents i LEFT JOIN alert_outbox a ON a.incident_id=i.id
      LEFT JOIN observations o ON o.project_id=i.project_id AND o.host=i.host
      WHERE i.project_id=$1 AND i.host='confirmed-fixture.test' GROUP BY i.status`,[project]);
    assert.deepEqual(row,{status:'unverified',alerts:1,observations:1});
    assert.equal(db.waitingCount,0);
  } finally {
    for(const table of ['observation_source_days','observations','incidents'])
      await db.query('DELETE FROM '+table+' WHERE project_id=$1',[project]);
    await db.end();
  }
});

test('full incident capacity reports the limit, retains triage and admits a later ordinary observation', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='capacity_'+crypto.randomUUID().replaceAll('-','');
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  await root.query('CREATE SCHEMA '+schema);
  try {
    for(const name of (await readdir('infra')).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())
      await db.query((await readFile('infra/'+name,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('p','Fixture','https://original.test')");
    await db.query(`INSERT INTO incidents(project_id,host,first_seen,last_seen,status,triage_version)
      SELECT 'p','host-'||n||'.test',
        now()-CASE WHEN n<=2 THEN interval '31 days' ELSE interval '1 hour' END,now(),
        CASE WHEN n=2 THEN 'confirmed_copy' WHEN n BETWEEN 3 AND 13 THEN 'false_positive' ELSE 'unverified' END,
        CASE WHEN n BETWEEN 2 AND 13 THEN 1 ELSE 0 END
      FROM generate_series(1,100) n`);
    await db.query("UPDATE incidents SET first_seen=now()-interval '35 days',last_seen=now()-interval '31 days' WHERE project_id='p' AND host='host-3.test'");
    await db.query(`INSERT INTO incident_status_audit(incident_id,actor,previous_status,new_status,justification)
      SELECT id,'local_administrator','unverified','false_positive','Classified fixture'
      FROM incidents WHERE project_id='p' AND host='host-3.test'`);
    assert.deepEqual(await incidentCapacity(db,'p'),{total:100,common:89,totalLimit:100,commonLimit:90});
    assert.equal(await observe(db,'p','https://original.test','https://new-copy.test'),'capacity');

    await cleanup(db,'p');
    assert.deepEqual(await incidentCapacity(db,'p'),{total:99,common:88,totalLimit:100,commonLimit:90});
    assert.equal((await db.query("SELECT status FROM incidents WHERE project_id='p' AND host='host-2.test'")).rows[0].status,'confirmed_copy');
    assert.equal((await db.query(`SELECT a.id FROM incident_status_audit a JOIN incidents i ON i.id=a.incident_id
      WHERE i.project_id='p' AND i.host='host-3.test'`)).rowCount,1);
    assert.equal(await observe(db,'p','https://original.test','https://new-copy.test'),'observed');
    assert.equal((await db.query("SELECT a.id FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='p' AND i.host='new-copy.test'")).rowCount,1);
  } finally {
    await db.end();
    await root.query('DROP SCHEMA '+schema+' CASCADE');
    await root.end();
  }
});
