import { isIP } from 'node:net';
﻿import type { PoolClient } from 'pg';

// Callers hold the project advisory transaction lock. No user-provided payloads are accepted.
export type TimelineEvent = {
  project: string; host: string; type: 'first_observation' | 'source_observed' | 'risk_assessment' | 'degradation_transition' | 'dns_change' | 'incident_status_transition';
  source: string; provenance: 'gateway' | 'browser' | 'evaluator' | 'infrastructure' | 'administrator';
  reference?: string; summary: Record<string, string>; confidence: string; limitations: string;
};
export async function recordTimeline(client: PoolClient, event: TimelineEvent): Promise<void> {
  if (isIP(event.host.replace(/^\[|\]$/g,''))) return;
  const installed = await client.query("SELECT to_regclass('investigation_timeline') IS NOT NULL AS installed");
  if (!installed.rows[0].installed) return;
  await client.query("DELETE FROM investigation_timeline WHERE project_id=$1 AND recorded_at < clock_timestamp()-interval '30 days'", [event.project]);
  await client.query(`INSERT INTO investigation_timeline(project_id,host,event_type,source,provenance,original_ref,summary,confidence,limitations)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [event.project,event.host,event.type,event.source,event.provenance,event.reference ?? null,JSON.stringify(event.summary),event.confidence,event.limitations]);
  await client.query(`DELETE FROM investigation_timeline WHERE id IN (SELECT id FROM investigation_timeline
    WHERE project_id=$1 ORDER BY recorded_at DESC,id DESC OFFSET 10000)`, [event.project]);
}

// The caller owns the transaction. Recovery failures deliberately propagate.
export async function tryRecordTimeline(client: PoolClient, event: TimelineEvent): Promise<void> {
  await client.query('SAVEPOINT complementary_timeline');
  try {
    await recordTimeline(client, event);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT complementary_timeline');
    await client.query('RELEASE SAVEPOINT complementary_timeline');
    const code = (error as {code?: string}).code;
    if (code?.startsWith('08') || code?.startsWith('40') || code === '57P01') throw error;
    process.stderr.write('Investigation timeline event unavailable; history may be incomplete\n');
    return;
  }
  await client.query('RELEASE SAVEPOINT complementary_timeline');
}
