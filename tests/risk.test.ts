import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { evaluateRisk, recordRisk, safeEvaluateRisk } from '../apps/risk.js';
import { cleanup } from '../apps/detection.js';

test('assessment defaults to uncertainty; controlled LOW is explicitly a fixture', () => {
  assert.deepEqual(evaluateRisk(false), {level:'UNCERTAIN',version:'lab-risk-v1',source:'server_default',reason:'insufficient_evidence',confidence:'insufficient'});
  assert.deepEqual(evaluateRisk(true), {level:'LOW',version:'lab-risk-v1',source:'lab_configuration',reason:'controlled_fixture',confidence:'test_only'});
  assert.equal(safeEvaluateRisk(true, () => { throw Error('evaluator failure'); }), undefined);
});

test('risk persistence is deduplicated, versioned, isolated and retained seven days', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  for (const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments']) await db.query(await readFile(`infra/${file}.sql`, 'utf8'));
  const a = 'risk_' + crypto.randomUUID(), b = a + '_b';
  try {
    for (const id of [a,b]) { await recordRisk(db,id,'clone.test',evaluateRisk(false)); await recordRisk(db,id,'clone.test',evaluateRisk(false)); }
    const rows = await db.query('SELECT level,evaluator_version,source,reason,confidence FROM risk_assessment_days WHERE project_id=$1',[a]);
    assert.deepEqual(rows.rows, [{level:'UNCERTAIN',evaluator_version:'lab-risk-v1',source:'server_default',reason:'insufficient_evidence',confidence:'insufficient'}]);
    await db.query("UPDATE risk_assessment_days SET observed_at=now()-interval '8 days' WHERE project_id=$1",[a]);
    await cleanup(db,a);
    assert.equal((await db.query('SELECT 1 FROM risk_assessment_days WHERE project_id=$1',[a])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM risk_assessment_days WHERE project_id=$1',[b])).rowCount,1);
  } finally { await db.query('DELETE FROM risk_assessment_days WHERE project_id IN ($1,$2)',[a,b]); await db.end(); }
});
