import type { Pool } from 'pg';

// Operator likelihood is not identity; browser claims do not establish a class.
export type RiskAssessment = {
  level: 'HIGH' | 'LOW' | 'UNCERTAIN';
  version: 'lab-risk-v1';
  source: 'server_default' | 'lab_configuration';
  reason: 'insufficient_evidence' | 'controlled_fixture';
  confidence: 'insufficient' | 'test_only';
};
export function evaluateRisk(controlledFixture: boolean): RiskAssessment {
  return controlledFixture
    ? {level:'LOW', version:'lab-risk-v1', source:'lab_configuration', reason:'controlled_fixture', confidence:'test_only'}
    : {level:'UNCERTAIN', version:'lab-risk-v1', source:'server_default', reason:'insufficient_evidence', confidence:'insufficient'};
}
export function safeEvaluateRisk(controlledFixture: boolean, evaluator = evaluateRisk): RiskAssessment | undefined {
  try { return evaluator(controlledFixture); } catch { return undefined; }
}
export async function recordRisk(pool: Pool, project: string, host: string, assessment: RiskAssessment): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    const saved = await client.query(`INSERT INTO risk_assessment_days(project_id,host,day,level,evaluator_version,source,reason,confidence)
      SELECT $1,$2,(now() AT TIME ZONE 'UTC')::date,$3,$4,$5,$6,$7
      WHERE (SELECT count(*) FROM risk_assessment_days WHERE project_id=$1) < 1400
        OR EXISTS (SELECT 1 FROM risk_assessment_days WHERE project_id=$1 AND host=$2 AND day=(now() AT TIME ZONE 'UTC')::date AND level=$3 AND evaluator_version=$4 AND source=$5 AND reason=$6 AND confidence=$7)
      ON CONFLICT (project_id,host,day,level,evaluator_version,source,reason,confidence) DO UPDATE SET level=EXCLUDED.level RETURNING level`,
    [project,host,assessment.level,assessment.version,assessment.source,assessment.reason,assessment.confidence]);
    if (!saved.rowCount) throw new Error('risk capacity exceeded');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
