import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { classifyTraffic } from '../apps/traffic.js';
import { cleanup, observe } from '../apps/detection.js';

test('declared indicators are validated and never corroboration or risk', () => {
  const origin = 'https://clone.test';
  assert.deepEqual(classifyTraffic({clickId:'abc',clickKey:'gclid'},origin), {trafficClass:'PAID_ATTRIBUTED', evidence:'paid_click_id', source:'gclid', certainty:'browser_declared_uncorroborated'});
  assert.equal(classifyTraffic({medium:'cpc'},origin).trafficClass, 'PAID_ATTRIBUTED');
  assert.equal(classifyTraffic({referrerHost:'www.google.com'},origin).trafficClass, 'ORGANIC');
  assert.equal(classifyTraffic({referrerHost:'example.test'},origin).trafficClass, 'REFERRAL');
  assert.equal(classifyTraffic({},origin).trafficClass, 'DIRECT_UNKNOWN');
  assert.equal(classifyTraffic({referrerHost:'clone.test'},origin).trafficClass, 'DIRECT_UNKNOWN');
  for (const bad of [{evidence:'paid_click_id'}, {clickId:'abc',clickKey:['gclid']}, {clickId:'x'.repeat(129)}, {medium:'untrusted'}, {referrerHost:'https://google.com/private'}, null]) assert.throws(() => classifyTraffic(bad,origin));
});

test('postgres: project isolation, daily deduplication and retention', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  for (const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations']) await db.query(await readFile(`infra/${file}.sql`, 'utf8'));
  const a = 'traffic_' + crypto.randomUUID(), b = a + '_b';
  try {
    for (const project of [a,b]) for (const evidence of [{clickId:'abc',clickKey:'gclid'}, {medium:'cpc'}, {referrerHost:'google.com'}, {referrerHost:'example.test'}, {}]) {
      await observe(db, project, 'https://original.test', 'https://clone.test', 'core', evidence);
      await observe(db, project, 'https://original.test', 'https://clone.test', 'core', evidence);
    }
    assert.equal((await db.query('SELECT * FROM traffic_observation_days WHERE project_id=$1', [a])).rowCount, 5);
    await db.query("UPDATE traffic_observation_days SET observed_at=now()-interval '8 days' WHERE project_id=$1", [a]);
    await cleanup(db,a);
    assert.equal((await db.query('SELECT * FROM traffic_observation_days WHERE project_id=$1', [a])).rowCount, 0);
    assert.equal((await db.query('SELECT * FROM traffic_observation_days WHERE project_id=$1', [b])).rowCount, 5);
  } finally {
    for (const table of ['traffic_observation_days','observation_source_days','observation_days','observations','incidents']) await db.query(`DELETE FROM ${table} WHERE project_id IN ($1,$2)`, [a,b]);
    await db.end();
  }
});
