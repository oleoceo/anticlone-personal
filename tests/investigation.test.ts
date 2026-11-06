import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { investigation } from '../apps/investigation.js';
import { observe } from '../apps/detection.js';
import { evaluateRisk, recordRisk } from '../apps/risk.js';

test('investigation isolates projects, preserves first receipt and marks claims and daily aggregates', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'investigation_' + crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL, options:`-c search_path=${schema}`});
  try {
    for (const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await observe(db,'a','https://original.test','https://copy.test','core');
    const first = (await investigation(db,'a'))[0];
    await Promise.all([observe(db,'a','https://original.test','https://copy.test','fallback'), observe(db,'b','https://original.test','https://copy.test','core')]);
    await recordRisk(db,'a','copy.test',evaluateRisk(false),{source:'browser',reliability:'uncorroborated',trafficClass:'DIRECT_UNKNOWN',kind:'none'});
    const rows = await investigation(db,'a');
    assert.equal(rows.length,1);
    assert.deepEqual(rows[0].first_observed_at,first.first_observed_at);
    assert.deepEqual(rows[0].observation_sources.map((s: {source:string})=>s.source),['core','fallback']);
    assert.equal(rows[0].assessments[0].evidence_provenance,'browser');
    assert.equal(rows[0].assessments[0].evidence_reliability,'uncorroborated');
    assert.equal((await investigation(db,'b'))[0].assessments.length,0);
    assert.equal((await investigation(db,'missing')).length,0);
    assert.ok(rows[0].limitations.some((s:string)=>s.includes('daily aggregates')));
  } finally { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
});
