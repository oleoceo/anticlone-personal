import { assessEvidence } from './risk.js';
﻿import type { Pool } from 'pg';

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
  // Optional migrations may be absent on older installations. Catalog errors and
  // query errors propagate as 503 rather than being presented as missing data.
  const schema = await pool.query(`SELECT to_regclass('degradation_events') IS NOT NULL AND to_regclass('degradation_audit') IS NOT NULL AS degradation,
    to_regclass('degradation_collection_gaps') IS NOT NULL AS gaps,
    to_regclass('infrastructure_dns_observations') IS NOT NULL AS infrastructure,
    to_regclass('investigation_timeline') IS NOT NULL AS timeline`);
  const available = schema.rows[0];
  const states = available.degradation ? await pool.query(`SELECT DISTINCT ON (host) host,state,observed_at,window_start,uncertainty FROM degradation_audit
    WHERE project_id=$1 AND observed_at>=now()-interval '7 days' ORDER BY host,observed_at DESC`,[project]) : {rows:[]};
  const events = available.degradation ? await pool.query(`SELECT host,source,observed_at FROM degradation_events
    WHERE project_id=$1 AND observed_at>=now()-interval '24 hours' ORDER BY observed_at DESC LIMIT 10000`,[project]) : {rows:[]};
  const gaps = available.gaps ? await pool.query(`SELECT last_dropped_at FROM degradation_collection_gaps
    WHERE project_id=$1 AND last_dropped_at>=now()-interval '30 minutes'`,[project]) : {rows:[]};
  const dns = available.infrastructure ? await pool.query(`SELECT d.host,d.record_type,d.result,d.source,d.state,d.observed_at,d.valid_until,d.limitations,
    p.result AS previous_result,p.state AS previous_state,p.observed_at AS previous_observed_at,
    EXISTS(SELECT 1 FROM infrastructure_dns_observations g WHERE g.project_id=d.project_id AND g.host=d.host AND g.record_type=d.record_type AND g.state NOT IN ('OK','NO_DATA') AND g.observed_at>p.observed_at AND g.observed_at<d.observed_at) AS intervening_gap
    FROM infrastructure_dns_observations d LEFT JOIN LATERAL (SELECT result,state,observed_at FROM infrastructure_dns_observations x
      WHERE x.project_id=d.project_id AND x.host=d.host AND x.record_type=d.record_type AND x.state IN ('OK','NO_DATA') AND (x.observed_at,x.id)<(d.observed_at,d.id)
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) p ON true
    WHERE d.project_id=$1 AND d.observed_at>=now()-interval '30 days' ORDER BY d.observed_at DESC,d.id DESC LIMIT 12000`,[project]) : {rows:[]};
  const timeline = available.timeline ? await pool.query(`SELECT * FROM (SELECT id,host,event_type,source,provenance,recorded_at,original_ref,summary,confidence,limitations,
    row_number() OVER (PARTITION BY host ORDER BY recorded_at DESC,id DESC) AS rank FROM investigation_timeline
    WHERE project_id=$1 AND recorded_at>=clock_timestamp()-interval '30 days') t WHERE rank<=100 ORDER BY recorded_at,id`,[project]) : {rows:[]};
  return result.rows.map(row => ({ ...row,
    timeline: {available:available.timeline, limit:100, retention_days:30, events:timeline.rows.filter(event=>event.host===row.host), limitations:['Events begin with installation; legacy history is not reconstructed. Capacity and retention may remove older events. Recording errors may leave gaps.']},
    infrastructure: {available:available.infrastructure, dns:dns.rows.filter(item=>item.host===row.host).map(item=>({...item,
      validity:'UNKNOWN',
      changed:['OK','NO_DATA'].includes(item.state) && item.previous_result!==null && (item.state!==item.previous_state || JSON.stringify(item.result)!==JSON.stringify(item.previous_result)),
      reliability:'resolver_response_not_identity'})), asn:'NOT_AVAILABLE', hosting:'NOT_AVAILABLE',
      limitations:['DNS describes infrastructure, not visitor or operator identity.', 'No authoritative ASN or hosting source configured.', 'Expired, failed and absent records do not establish current infrastructure.']},
    assessments: row.assessments.map((assessment: {version:string; level:string; source:string; confidence:string; evidence_provenance:string; evidence_reliability:string; evidence_kind:string}) => {
      // v3 receives these exact two categories at request time. Older rows and
      // unknown writes cannot be reconstructed; daily upserts retain only the latest.
      const known = assessment.version === 'conservative-risk-v3' && assessment.evidence_provenance === 'browser' && assessment.evidence_reliability === 'uncorroborated' && assessment.evidence_kind !== 'legacy_unavailable';
      const reconstruction = known ? assessEvidence([
        {type:assessment.evidence_kind === 'none' ? 'no_attribution' : 'traffic_claim',provenance:'browser',reliability:'uncorroborated',validity:'current'},
        {type:'gateway_receipt',provenance:'gateway',reliability:'observed',validity:'current'}], assessment.source === 'lab_configuration') : null;
      return {...assessment, reconstructed_at_decision: reconstruction && {sources:reconstruction.sources, limitations:reconstruction.limitations},
        synthetic_high_fixture: assessment.level === 'HIGH' && assessment.source === 'lab_configuration' && assessment.confidence === 'test_only'};
    }),
    degradation: {available: available.degradation, inference: states.rows.find(state => state.host === row.host) ?? null, received_claims: events.rows.filter(event => event.host === row.host)},
    collection_gap: {scope: 'project', available: available.gaps, last_dropped_at: gaps.rows[0]?.last_dropped_at ?? null},
    limitations: ['Host and traffic attribution are browser claims; gateway receipt time does not verify them.',
      'Sources may share one browser context; temporal proximity does not establish independence.',
      'Absence of a signal is not evidence of absence; collection may be incomplete. A project gap is not attributed to this host.',
      'First observation is not the creation date; history is subject to retention.',
      'Assessments are daily aggregates: evidence can be overwritten and does not determine another session.'] }));
}
