import type { Pool } from 'pg';

// These are retained observations, not an identity or a session decision.
export async function investigation(pool: Pool, project: string) {
  const result = await pool.query(`SELECT i.host, i.first_seen AS first_observed_at, i.last_seen AS last_observed_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',s.source,'day',s.day) ORDER BY s.day,s.source)
      FROM observation_source_days s WHERE s.project_id=i.project_id AND s.host=i.host AND s.day >= (now() AT TIME ZONE 'UTC')::date-7), '[]'::jsonb) AS observation_sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',t.source,'kind',t.evidence,'day',t.day,'observed_at',t.observed_at) ORDER BY t.observed_at)
      FROM traffic_observation_days t WHERE t.project_id=i.project_id AND t.host=i.host AND t.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS browser_claims,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',c.source,'observed_at',c.observed_at) ORDER BY c.observed_at)
      FROM canary_observations c WHERE c.project_id=i.project_id AND c.host=i.host AND c.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS canary_claims,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('level',r.level,'version',r.evaluator_version,'source',r.source,'reason',r.reason,'confidence',r.confidence,'evidence_kind',r.evidence_kind,'evidence_provenance',r.evidence_provenance,'evidence_reliability',r.evidence_reliability,'observed_at',r.observed_at) ORDER BY r.observed_at)
      FROM risk_assessment_days r WHERE r.project_id=i.project_id AND r.host=i.host AND r.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS assessments
    FROM incidents i WHERE i.project_id=$1 AND i.last_seen >= now()-interval '30 days' ORDER BY i.last_seen DESC,i.host LIMIT 100`, [project]);
  return result.rows.map(row => ({ ...row,
    limitations: ['Host and traffic attribution are browser claims; gateway receipt time does not verify them.',
      'Sources may share one browser context; temporal proximity does not establish independence.',
      'Absence of a signal is not evidence of absence; collection may be incomplete. Degradation and collection gaps are not included in this summary.',
      'First observation is not the creation date; history is subject to retention.',
      'Assessments are daily aggregates: evidence can be overwritten and does not determine another session.'] }));
}
