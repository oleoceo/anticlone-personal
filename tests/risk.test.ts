import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assessObservation, evaluateRisk, recordRisk, safeEvaluateRisk, stealthEligible } from '../apps/risk.js';
import { cleanup } from '../apps/detection.js';

test('assessment defaults to uncertainty; controlled LOW is explicitly a fixture', () => {
  assert.deepEqual(evaluateRisk(false), {level:'UNCERTAIN',version:'conservative-risk-v2',source:'server_default',reason:'insufficient_evidence',confidence:'insufficient'});
  assert.deepEqual(evaluateRisk(true), {level:'LOW',version:'conservative-risk-v2',source:'lab_configuration',reason:'controlled_fixture',confidence:'test_only'});
  assert.equal(safeEvaluateRisk(true, () => { throw Error('evaluator failure'); }), undefined);
});

test('uncorroborated attribution does not determine operational risk', () => {
  for (const trafficClass of ['PAID_ATTRIBUTED', 'ORGANIC', 'REFERRAL', 'DIRECT_UNKNOWN', 'spoofed']) {
    assert.equal(assessObservation({source:'browser', reliability:'uncorroborated', trafficClass}, false).level, 'UNCERTAIN');
  }
  assert.equal(safeEvaluateRisk(false, () => { throw Error('failure'); }), undefined);
});

test('shared stealth gate permits only the controlled fixture outside pilot', () => {
  const fixture = evaluateRisk(true);
  assert.equal(stealthEligible(fixture, false), true);
  assert.equal(stealthEligible(fixture, true), false);
  assert.equal(stealthEligible(undefined, false), false);
  assert.equal(stealthEligible(evaluateRisk(false), false), false);
  assert.equal(stealthEligible({...fixture, level:'HIGH'}, false), false);
  assert.equal(stealthEligible({...fixture, level:'UNCERTAIN'}, false), false);
});

test('risk migration preserves legacy rows and permits old writes on code rollback', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'risk_migration_' + crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    await db.query(await readFile('infra/009_risk_assessments.sql','utf8'));
    const oldInsert = `INSERT INTO risk_assessment_days(project_id,host,day,level,evaluator_version,source,reason,confidence) VALUES($1,'copy.test',current_date,'UNCERTAIN','lab-risk-v1','server_default','insufficient_evidence','insufficient')`;
    await db.query(oldInsert,['legacy']);
    await db.query(await readFile('infra/024_risk_evidence.sql','utf8'));
    assert.equal((await db.query('SELECT evidence_provenance FROM risk_assessment_days WHERE project_id=$1',['legacy'])).rows[0].evidence_provenance,'legacy_unavailable');
    await recordRisk(db,'new','copy.test',evaluateRisk(false),{source:'browser',reliability:'uncorroborated',trafficClass:'PAID_ATTRIBUTED',kind:'paid_utm'});
    await db.query(oldInsert,['rollback']);
    const rows = await db.query('SELECT project_id,evidence_provenance FROM risk_assessment_days ORDER BY project_id');
    assert.deepEqual(rows.rows,[{project_id:'legacy',evidence_provenance:'legacy_unavailable'},{project_id:'new',evidence_provenance:'browser'},{project_id:'rollback',evidence_provenance:'legacy_unavailable'}]);
  } finally { await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
});

test('risk persistence is deduplicated, versioned, isolated and retained seven days', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  for (const file of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence']) await db.query(await readFile(`infra/${file}.sql`, 'utf8'));
  const a = 'risk_' + crypto.randomUUID(), b = a + '_b';
  try {
    for (const id of [a,b]) { await recordRisk(db,id,'clone.test',evaluateRisk(false),{source:'browser',reliability:'uncorroborated',trafficClass:'PAID_ATTRIBUTED',kind:'paid_utm'}); await recordRisk(db,id,'clone.test',evaluateRisk(false),{source:'browser',reliability:'uncorroborated',trafficClass:'PAID_ATTRIBUTED',kind:'paid_utm'}); }
    const rows = await db.query('SELECT level,evaluator_version,source,reason,confidence FROM risk_assessment_days WHERE project_id=$1',[a]);
    assert.deepEqual(rows.rows, [{level:'UNCERTAIN',evaluator_version:'conservative-risk-v2',source:'server_default',reason:'insufficient_evidence',confidence:'insufficient'}]);
    const evidence = await db.query('SELECT evidence_kind,evidence_provenance,evidence_reliability FROM risk_assessment_days WHERE project_id=$1',[a]);
    assert.deepEqual(evidence.rows, [{evidence_kind:'paid_utm',evidence_provenance:'browser',evidence_reliability:'uncorroborated'}]);
    await db.query("UPDATE risk_assessment_days SET observed_at=now()-interval '8 days' WHERE project_id=$1",[a]);
    await cleanup(db,a);
    assert.equal((await db.query('SELECT 1 FROM risk_assessment_days WHERE project_id=$1',[a])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM risk_assessment_days WHERE project_id=$1',[b])).rowCount,1);
  } finally { await db.query('DELETE FROM risk_assessment_days WHERE project_id IN ($1,$2)',[a,b]); await db.end(); }
});
