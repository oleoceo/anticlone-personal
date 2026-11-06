import type { Pool } from 'pg';

import { tryRecordTimeline } from './investigation-timeline.js';

const statuses = ['unverified','investigating','confirmed_copy','false_positive'];
export class IncidentConflict extends Error {}
export async function classifyIncident(db: Pool, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('invalid request');
  const data = body as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'expected,host,incident_id,justification,project,status,version' ||
      typeof data.project !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.project) ||
      typeof data.host !== 'string' || data.host.length < 1 || data.host.length > 253 ||
      typeof data.incident_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(data.incident_id) ||
      typeof data.expected !== 'string' || !statuses.includes(data.expected) ||
      typeof data.version !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(data.version) ||
      typeof data.status !== 'string' || !statuses.includes(data.status) || data.status === data.expected ||
      typeof data.justification !== 'string' || !data.justification.trim() || data.justification.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(data.justification)) throw new TypeError('invalid request');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [data.project]);
    const incident = await client.query('SELECT id,status,triage_version FROM incidents WHERE project_id=$1 AND host=$2 FOR UPDATE',[data.project,data.host]);
    if (!incident.rowCount || incident.rows[0].id !== data.incident_id || incident.rows[0].status !== data.expected || incident.rows[0].triage_version !== data.version) throw new IncidentConflict('incident changed or unavailable');
    await client.query('UPDATE incidents SET status=$1,triage_version=triage_version+1 WHERE id=$2',[data.status,incident.rows[0].id]);
    const audit = await client.query('INSERT INTO incident_status_audit(incident_id,actor,previous_status,new_status,justification) VALUES($1,$2,$3,$4,$5) RETURNING id',[incident.rows[0].id,'local_administrator',data.expected,data.status,data.justification.trim()]);
    await tryRecordTimeline(client, {project:data.project,host:data.host,type:'incident_status_transition',source:'local_administrator',provenance:'administrator',reference:'incident_status_audit:'+audit.rows[0].id,summary:{previous_status:data.expected,new_status:data.status},confidence:'manual_decision',limitations:'Manual assessment of the copy does not identify its operator. Alerts remain unchanged.'});
    await client.query('COMMIT');
    return {status:data.status};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
