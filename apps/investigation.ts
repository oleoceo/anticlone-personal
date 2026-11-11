import { copyHistory } from './copy-history.js';
import { assessEvidence } from './risk.js';
import {evaluateOperator,type OperatorSignal} from './operator-shadow.js';
import {receiptColumns,presentReceipt} from './investigation-receipts.js';
﻿import type { Pool } from 'pg';

// These are retained observations, not an identity or a session decision.
export async function investigation(pool: Pool, project: string) {
  const schema = await pool.query(`SELECT to_regclass('degradation_events') IS NOT NULL AND to_regclass('degradation_audit') IS NOT NULL AS degradation,
    to_regclass('degradation_collection_gaps') IS NOT NULL AS gaps,
    to_regclass('infrastructure_dns_observations') IS NOT NULL AS infrastructure,
    to_regclass('investigation_timeline') IS NOT NULL AS timeline,
    to_regclass('investigation_receipts') IS NOT NULL AS receipts,
    to_regclass('cta_drift_alerts') IS NOT NULL AS cta,
    to_regclass('incident_status_audit') IS NOT NULL AS audit,
    to_regclass('alert_outbox') IS NOT NULL AS notifications,
    to_regclass('notification_lifecycle_queue') IS NOT NULL AS notification_holds,
    to_regclass('clone_delivery_attempts') IS NOT NULL AS notification_history,
    to_regclass('operator_shadow_assessments') IS NOT NULL AS shadow,
    to_regclass('authorized_activity') IS NOT NULL AS activity`);
  const available = schema.rows[0];
  const activity=available.activity?await pool.query(`SELECT page_id,source,event_id,observed_at,received_at,payload->>'kind' AS kind,payload->>'resource' AS resource
    FROM authorized_activity WHERE project_id=$1 AND observed_at>=clock_timestamp()-interval '7 days' ORDER BY observed_at DESC,event_id LIMIT 100`,[project]):{rows:[]};
  const shadow=available.shadow?await pool.query(`SELECT host,page_id,recorded_at,assessment FROM
    (SELECT host,page_id,recorded_at,assessment,row_number() OVER(PARTITION BY host ORDER BY recorded_at DESC,id DESC) AS rank
    FROM operator_shadow_assessments WHERE project_id=$1 AND recorded_at>=clock_timestamp()-interval '7 days') t WHERE rank<=20`,[project]):{rows:[]};
  const cta=available.cta?await pool.query('SELECT id,point_id,reason,created_at FROM cta_drift_alerts WHERE project_id=$1 AND created_at>=clock_timestamp()-interval \'30 days\' ORDER BY created_at,id LIMIT 100',[project]):{rows:[]};
  const receipts=available.receipts?await pool.query(`SELECT ${receiptColumns} FROM investigation_receipts r WHERE project_id=$1 AND last_received_at>=clock_timestamp()-interval '7 days' AND ((to_jsonb(r)->>'accessed_at') IS NULL OR (to_jsonb(r)->>'accessed_at')::timestamptz>=clock_timestamp()-interval '7 days') ORDER BY id LIMIT 10000`,[project]):{rows:[]};
  const pagesByHost=new Map<string,Set<string>>();
  for(const receipt of receipts.rows)if(receipt.claimed_host){const pages=pagesByHost.get(receipt.claimed_host)??new Set<string>();pages.add(receipt.page_id);pagesByHost.set(receipt.claimed_host,pages);}
  const result = await pool.query(`SELECT i.id AS incident_id, i.host, i.status, ${available.audit ? 'i.triage_version' : 'NULL AS triage_version'}, i.first_seen AS first_observed_at, i.last_seen AS last_observed_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',s.source,'day',s.day) ORDER BY s.day,s.source)
      FROM observation_source_days s WHERE s.project_id=i.project_id AND s.host=i.host AND s.day >= (now() AT TIME ZONE 'UTC')::date-7), '[]'::jsonb) AS observation_sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('traffic_class',t.traffic_class,'source',t.source,'kind',t.evidence,'day',t.day,'observed_at',t.observed_at) ORDER BY t.observed_at)
      FROM traffic_observation_days t WHERE t.project_id=i.project_id AND t.host=i.host AND t.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS browser_claims,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',c.source,'observed_at',c.observed_at) ORDER BY c.observed_at)
      FROM canary_observations c WHERE c.project_id=i.project_id AND c.host=i.host AND c.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS canary_claims,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('level',r.level,'version',r.evaluator_version,'source',r.source,'reason',r.reason,'confidence',r.confidence,'evidence_kind',r.evidence_kind,'evidence_provenance',r.evidence_provenance,'evidence_reliability',r.evidence_reliability,'observed_at',r.observed_at) ORDER BY r.observed_at)
      FROM risk_assessment_days r WHERE r.project_id=i.project_id AND r.host=i.host AND r.observed_at >= now()-interval '7 days'), '[]'::jsonb) AS assessments
    FROM incidents i WHERE i.project_id=$1 AND i.last_seen >= now()-interval '30 days' ORDER BY i.last_seen DESC,i.host LIMIT 100`, [project]);
  // Optional migrations may be absent on older installations. Catalog errors and
  // query errors propagate as 503 rather than being presented as missing data.
  const states = available.degradation ? await pool.query(`SELECT DISTINCT ON (host) host,state,observed_at,window_start,uncertainty FROM degradation_audit
    WHERE project_id=$1 AND observed_at>=now()-interval '7 days' ORDER BY host,observed_at DESC`,[project]) : {rows:[]};
  const events = available.degradation ? await pool.query(`SELECT host,source,observed_at FROM degradation_events
    WHERE project_id=$1 AND observed_at>=now()-interval '24 hours' ORDER BY observed_at DESC LIMIT 10000`,[project]) : {rows:[]};
  const gaps = available.gaps ? await pool.query(`SELECT last_dropped_at FROM degradation_collection_gaps
    WHERE project_id=$1 AND last_dropped_at>=now()-interval '30 minutes'`,[project]) : {rows:[]};
  const dns = available.infrastructure ? await pool.query(`SELECT d.host,d.record_type,d.result,d.source,d.state,d.observed_at,d.valid_until,d.limitations,
    p.result AS previous_result,p.state AS previous_state,p.observed_at AS previous_observed_at,
    EXISTS(SELECT 1 FROM infrastructure_dns_observations g WHERE g.project_id=d.project_id AND g.host=d.host AND g.record_type=d.record_type AND g.source=d.source AND g.state NOT IN ('OK','NO_DATA') AND g.observed_at>p.observed_at AND g.observed_at<d.observed_at) AS intervening_gap
    FROM infrastructure_dns_observations d LEFT JOIN LATERAL (SELECT result,state,observed_at FROM infrastructure_dns_observations x
      WHERE x.project_id=d.project_id AND x.host=d.host AND x.record_type=d.record_type AND x.source=d.source AND x.state IN ('OK','NO_DATA') AND (x.observed_at,x.id)<(d.observed_at,d.id)
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) p ON true
    WHERE d.project_id=$1 AND d.observed_at>=now()-interval '30 days' ORDER BY d.observed_at DESC,d.id DESC LIMIT 12000`,[project]) : {rows:[]};
  const timeline = available.timeline ? await pool.query(`SELECT * FROM (SELECT id,host,event_type,source,provenance,recorded_at,original_ref,summary,confidence,limitations,
    row_number() OVER (PARTITION BY host ORDER BY recorded_at DESC,id DESC) AS rank FROM investigation_timeline
    WHERE project_id=$1 AND recorded_at>=clock_timestamp()-interval '30 days') t WHERE rank<=100 ORDER BY recorded_at,id`,[project]) : {rows:[]};
  const audit = available.audit ? await pool.query(`SELECT i.host,a.id,a.actor,a.previous_status,a.new_status,a.justification,a.alert_disposition,a.recorded_at FROM incident_status_audit a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 ORDER BY a.recorded_at,a.id`,[project]) : {rows:[]};
  const notifications = available.notifications ? await pool.query(`SELECT i.id AS incident_id,a.id AS outbox_id,a.attempts,a.next_attempt,a.sent_at,
    CASE WHEN a.sent_at IS NOT NULL THEN 'ACCEPTED_BY_TRANSPORT' WHEN to_jsonb(a)->>'expired_at' IS NOT NULL THEN 'EXPIRED'
      ${available.notification_holds ? "WHEN EXISTS(SELECT 1 FROM notification_lifecycle_queue h WHERE h.project_id=i.project_id AND h.queue='CLONE' AND h.item_id=a.id::text) THEN (SELECT h.hold_state FROM notification_lifecycle_queue h WHERE h.project_id=i.project_id AND h.queue='CLONE' AND h.item_id=a.id::text)" : ''}
      WHEN a.attempts>=3 THEN 'EXHAUSTED' ELSE 'PENDING' END AS state
    FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1`,[project]) : {rows:[]};
  const notificationHistory = available.notification_history ? await pool.query(`SELECT h.outbox_id,h.attempt,h.transport,h.started_at,h.finished_at,h.outcome
    FROM clone_delivery_attempts h JOIN alert_outbox a ON a.id=h.outbox_id JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 ORDER BY h.outbox_id,h.attempt`,[project]) : {rows:[]};
  return result.rows.map(row => {
    const direct=receipts.rows.filter(item=>item.claimed_host===row.host);
    const shared=receipts.rows.filter(item=>!item.claimed_host&&pagesByHost.get(row.host)?.has(item.page_id));
    // Keep the first retained event and the most recent events, without repeating
    // the entire LP log for each incident. Full evidence remains paginated.
    const preview=(items:typeof receipts.rows,limit:number)=>{
      if(items.length<=limit)return items;
      const earliest=items.reduce((a,b)=>new Date(a.accessed_at??a.first_received_at).getTime()<=new Date(b.accessed_at??b.first_received_at).getTime()?a:b);
      return [earliest,...items.filter(item=>item.id!==earliest.id).slice(-(limit-1))];
    };
    const linked=[...preview(direct,10),...preview(shared,3)];
    const kinds=new Set([...direct,...shared].map(item=>item.kind));
    const profileSignals:OperatorSignal[]=direct.slice(-99).map(item=>({kind:'activity',scope:'group',source:'gateway',
      observedAt:new Date(item.last_received_at).getTime(),validUntil:new Date(item.last_received_at).getTime()+300000,reference:'receipt:'+item.id}));
    const minutes=new Set(direct.map(item=>Math.floor(new Date(item.last_received_at).getTime()/60000)));
    if(minutes.size>1&&profileSignals.length)profileSignals.push({...profileSignals[profileSignals.length-1],kind:'repeated_activity',reference:'distinct_receipt_minutes'});
    return { ...row,
    operator_profile:{scope:'PROJECT_HOST_CONTEXT',assessment:evaluateOperator(profileSignals,Date.now()),
      authorized_activity:{available:available.activity,scope:'PAGE_GROUP_CONTEXT_NOT_CURRENT_SESSION',limit:100,retention_days:7,
        events:activity.rows.filter(item=>pagesByHost.get(row.host)?.has(item.page_id)),
        limitation:'Signed source assertions; request is not complete download. Only source-issued test contexts can support session correlation; ordinary CDN logs cannot identify an operator.'},
      temporal:{retained_receipts:direct.length,distinct_minutes:minutes.size,first_observed_at:row.first_observed_at,last_observed_at:row.last_observed_at},
      behavioral:{available:false,reason:'No independently observed session behavior retained'},
      network:{available:false,reason:'DNS describes hosting; no visitor network evidence collected'},
      geography:{available:false,precision:'APPROXIMATE_ONLY',reason:'No authorized enrichment source configured; never GPS'},
      sessions:{available:available.shadow,events:shadow.rows.filter(item=>item.host===row.host).map(item=>({...item,current:Number(item.assessment.validUntil)>Date.now()})),limit:20,retention_days:7},
      limitations:['Group activity never assigns operator likelihood to a session','Session contexts are untrusted, scoped and rotated daily; no cross-site/device identity','Queue loss, minute deduplication and capacity limits can omit evidence']},
    project_cta_context:{available:available.cta,events:cta.rows,relation:'PROJECT_ONLY',limitation:'CTA drift belongs to this project; no host, visitor or incident causality is established.'},
    contextual_assessment:assessEvidence([
      ...(kinds.has('original_request')?[{type:'original_request_import' as const,provenance:'administrator' as const,reliability:'uncorroborated' as const,validity:'unknown' as const}]:[]),
      ...(kinds.has('runtime_receipt')?[{type:'runtime_resource' as const,provenance:'gateway' as const,reliability:'observed' as const,validity:'unknown' as const}]:[]),
      ...(dns.rows.some(item=>item.host===row.host)?[{type:'dns_observation' as const,provenance:'infrastructure' as const,reliability:'observed' as const,validity:'unknown' as const}]:[]),
      ...(row.status==='confirmed_copy'?[{type:'administrative_copy_confirmation' as const,provenance:'administrator' as const,reliability:'uncorroborated' as const,validity:'unknown' as const}]:[]),
      ...(gaps.rows.length?[{type:'collection_gap' as const,provenance:'gateway' as const,reliability:'unknown' as const,validity:'unknown' as const}]:[])
    ],false),
    linked_evidence: {
      available:available.receipts,original_access_coverage:'NOT_OBSERVABLE_UNLESS_IMPORTED',
      events:linked.map(item=>presentReceipt(item,row.host)),total:direct.length+shared.length,preview_limit:13,
      omitted:direct.length+shared.length-linked.length,history_endpoint:`/admin/projects/${project}/investigation-receipts`,
      limitation:'LP/installation and claimed hostname are context links only. Shared LP, alias, time or resource does not link visitors or identify an operator. Import time is not original access time. Missing or saturated collection remains unknown.'
    },
    notification: {available:available.notifications,history_available:available.notification_history,
      outbox:notifications.rows.find(item=>item.incident_id===row.incident_id) ?? null,
      history:notificationHistory.rows.filter(item=>item.outbox_id===notifications.rows.find(notification=>notification.incident_id===row.incident_id)?.outbox_id),
      limitation:'Transport acceptance is not mailbox delivery. Interrupted acceptance can cause duplicates on retry.'},
    status_audit: {available:available.audit, events:audit.rows.filter(event=>event.host===row.host)},
    timeline: {available:available.timeline, limit:100, retention_days:30, events:timeline.rows.filter(event=>event.host===row.host), limitations:['Events begin with installation; legacy history is not reconstructed. Capacity and retention may remove older events. Recording errors may leave gaps.']},
    infrastructure: {available:available.infrastructure, dns:dns.rows.filter(item=>item.host===row.host).map(item=>({...item,
      validity:'UNKNOWN',
      changed:['OK','NO_DATA'].includes(item.state) && item.previous_result!==null && (item.state!==item.previous_state || JSON.stringify(item.result)!==JSON.stringify(item.previous_result)),
      reliability:'resolver_response_not_identity'})), asn:'NOT_AVAILABLE', hosting:'NOT_AVAILABLE',
      limitations:['DNS describes infrastructure, not visitor or operator identity.', 'No authoritative ASN or hosting source configured.', 'Expired, failed and absent records do not establish current infrastructure.']},
    assessments: row.assessments.map((assessment: {version:string; level:string; source:string; confidence:string; evidence_provenance:string; evidence_reliability:string; evidence_kind:string}) => {
      // v3 and v4 receive these exact two categories at request time. Other rows and
      // unknown writes cannot be reconstructed; daily upserts retain only the latest.
      const known = ['conservative-risk-v3','conservative-risk-v4'].includes(assessment.version) && assessment.evidence_provenance === 'browser' && assessment.evidence_reliability === 'uncorroborated' && assessment.evidence_kind !== 'legacy_unavailable';
      const reconstruction = known ? assessEvidence([
        {type:assessment.evidence_kind === 'none' ? 'no_attribution' : 'traffic_claim',provenance:'browser',reliability:'uncorroborated',validity:'current'},
        {type:'gateway_receipt',provenance:'gateway',reliability:'observed',validity:'current'}], assessment.source === 'lab_configuration') : null;
      return {...assessment, reconstructed_at_decision: reconstruction && {sources:reconstruction.sources, hypothesis:reconstruction.hypothesis, limitations:assessment.version === 'conservative-risk-v3' ? ['Browser claims are manipulable; endpoints do not establish independence.', 'Gateway receipt does not verify the claimed host or identify a visitor.', 'No independent session-bound operator evidence is available.'] : reconstruction.limitations},
        synthetic_high_fixture: assessment.level === 'HIGH' && assessment.source === 'lab_configuration' && assessment.confidence === 'test_only'};
    }),
    degradation: {available: available.degradation, inference: states.rows.find(state => state.host === row.host) ?? null, received_claims: events.rows.filter(event => event.host === row.host)},
    collection_gap: {scope: 'project', available: available.gaps, last_dropped_at: gaps.rows[0]?.last_dropped_at ?? null},
    limitations: ['Host and traffic attribution are browser claims; gateway receipt time does not verify them.',
      'Sources may share one browser context; temporal proximity does not establish independence.',
      'Absence of a signal is not evidence of absence; collection may be incomplete. A project gap is not attributed to this host.',
      'First observation is not the creation date; history is subject to retention.',
      'Assessments are daily aggregates: evidence can be overwritten and does not determine another session.'] };}).map(row=>({...row, history:copyHistory(row)}));
}
