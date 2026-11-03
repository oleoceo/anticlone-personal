import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { configuredOrigin, hostFromUrl, observe } from '../apps/detection.js';
test('validates URLs and stores only normalized hostname', () => {
  assert.equal(hostFromUrl('https://EXAMPLE.test/private?q=secret'), 'example.test');
  assert.equal(configuredOrigin('https://example.test:8443/'), 'https://example.test:8443');
  assert.throws(() => configuredOrigin('https://example.test/path'));
  for (const value of ['file:///tmp/a', 'https://user:pass@example.test', 'invalid']) assert.throws(() => hostFromUrl(value));
});
test('real postgres: original, repeated simulated clone and reconnect', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to an isolated PostgreSQL test database');
  let pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(await readFile('infra/001_initial.sql', 'utf8'));
  await pool.query(await readFile('infra/002_alerts.sql', 'utf8')); await pool.query(await readFile('infra/004_observation_sources.sql', 'utf8'));
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
    await pool.query("INSERT INTO incidents(project_id,host) SELECT $1, 'host-' || n || '.test' FROM generate_series(1,99) n", [project]);
    assert.equal(await observe(pool, project, 'https://original.test', 'https://overflow.test'), 'capacity');
    assert.equal(await observe(pool, project, 'https://original.test', 'https://clone.test'), 'observed');
  } finally {
    await pool.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]);
      await pool.query('DELETE FROM observation_days WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM observations WHERE project_id=$1', [project]); await pool.query('DELETE FROM incidents WHERE project_id=$1', [project]); await pool.end();
  }
});
