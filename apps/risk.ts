import type { Pool } from 'pg';

// Operator likelihood is not identity; browser claims do not establish a class.
export type RiskAssessment = {
  level: 'HIGH' | 'LOW' | 'UNCERTAIN';
  version: 'conservative-risk-v2';
  source: 'server_default' | 'lab_configuration';
  reason: 'insufficient_evidence' | 'controlled_fixture';
  confidence: 'insufficient' | 'test_only';
};
export function evaluateRisk(controlledFixture: boolean): RiskAssessment {
  return controlledFixture
    ? {level:'LOW', version:'conservative-risk-v2', source:'lab_configuration', reason:'controlled_fixture', confidence:'test_only'}
    : {level:'UNCERTAIN', version:'conservative-risk-v2', source:'server_default', reason:'insufficient_evidence', confidence:'insufficient'};
}
// This gate grants eligibility only; each action still validates its own policy.
export function stealthEligible(assessment: RiskAssessment | undefined, pilot: boolean): boolean {
  return !pilot && assessment?.level === 'LOW' && assessment.version === 'conservative-risk-v2' && assessment.source === 'lab_configuration' && assessment.reason === 'controlled_fixture' && assessment.confidence === 'test_only';
}
// Browser-supplied observations are uncorroborated. They are deliberately not
// inputs to the classification; in particular paid attribution is not identity.
export type RiskEvidence = { source: 'browser'; reliability: 'uncorroborated'; trafficClass: string; kind?: 'paid_click_id' | 'paid_utm' | 'organic_referrer' | 'external_referrer' | 'none' };
export function assessObservation(evidence: RiskEvidence, controlledFixture: boolean): RiskAssessment {
  if (evidence.source !== 'browser' || evidence.reliability !== 'uncorroborated') throw Error('unsupported evidence');
  return evaluateRisk(controlledFixture);
}
export function safeEvaluateRisk(controlledFixture: boolean, evaluator = evaluateRisk): RiskAssessment | undefined {
  try { return evaluator(controlledFixture); } catch { return undefined; }
}
export async function recordRisk(pool: Pool, project: string, host: string, assessment: RiskAssessment, evidence?: RiskEvidence): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [project]);
    const saved = await client.query(`INSERT INTO risk_assessment_days(project_id,host,day,level,evaluator_version,source,reason,confidence,evidence_kind,evidence_provenance,evidence_reliability)
      SELECT $1,$2,(now() AT TIME ZONE 'UTC')::date,$3,$4,$5,$6,$7,$8,$9,$10
      WHERE (SELECT count(*) FROM risk_assessment_days WHERE project_id=$1) < 1400
        OR EXISTS (SELECT 1 FROM risk_assessment_days WHERE project_id=$1 AND host=$2 AND day=(now() AT TIME ZONE 'UTC')::date AND level=$3 AND evaluator_version=$4 AND source=$5 AND reason=$6 AND confidence=$7)
      ON CONFLICT (project_id,host,day,level,evaluator_version,source,reason,confidence) DO UPDATE SET evidence_kind=EXCLUDED.evidence_kind,evidence_provenance=EXCLUDED.evidence_provenance,evidence_reliability=EXCLUDED.evidence_reliability,observed_at=now() RETURNING level`,
    [project,host,assessment.level,assessment.version,assessment.source,assessment.reason,assessment.confidence,evidence?.kind ?? 'legacy_unavailable',evidence?.source ?? 'legacy_unavailable',evidence?.reliability ?? 'legacy_unavailable']);
    if (!saved.rowCount) throw new Error('risk capacity exceeded');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
