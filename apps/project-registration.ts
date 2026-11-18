import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {configuredOrigin} from './detection.js';

const intentUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type RegisteredProject = {id: string; name: string; origin: string};

export class ProjectRegistrationConflict extends Error {}

// Both authenticated entry points use this transaction. Audit failure must fail
// creation; no session token, MFA code or network identifier belongs in history.
export async function registerProject(db: Pool, input: unknown, intent?: unknown) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid project');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='name,origin' || typeof value.name!=='string' || !value.name.trim() || value.name.length>100 || typeof value.origin!=='string') throw new TypeError('invalid project');
  let origin: string;
  try { origin = configuredOrigin(value.origin); } catch { throw new TypeError('invalid origin'); }
  if (intent !== undefined && (typeof intent !== 'string' || !intentUuid.test(intent))) {
    throw new TypeError('invalid project registration key');
  }

  const identity = [intent?.toLowerCase() ?? randomUUID(), value.name.trim(), origin];
  const statement = intent === undefined
    ? 'INSERT INTO projects(id,name,origin) VALUES($1,$2,$3) RETURNING id,name,origin'
    : `INSERT INTO projects(id,name,origin)
       SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM project_registration_audit WHERE project_id=$1)
       ON CONFLICT (id) DO NOTHING RETURNING id,name,origin`;

  const client = await db.connect();
  try {
    // The read following a contested insert gets a fresh snapshot of the winner.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let row = (await client.query<RegisteredProject>(statement, identity)).rows[0];
    if (row) {
      await client.query('INSERT INTO project_registration_audit(project_id,name,origin) VALUES($1,$2,$3)', identity);
    } else {
      const replay = await client.query<RegisteredProject>(`
        SELECT p.id,p.name,p.origin FROM projects p
        JOIN LATERAL (
          SELECT name,origin FROM project_registration_audit WHERE project_id=p.id ORDER BY id LIMIT 1
        ) original ON original.name=$2 AND original.origin=$3
        WHERE p.id=$1`, identity);
      row = replay.rows[0];
      if (!row) throw new ProjectRegistrationConflict('registration key already used');
    }
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function registrationHistory(db:Pool,input:unknown) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid history');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='project' || typeof value.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.project)) throw new TypeError('invalid project');
  const registration=(await db.query('SELECT id,project_id,name,origin,occurred_at,actor,action FROM project_registration_audit WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[value.project])).rows;
  const changes=(await db.query('SELECT * FROM administrative_change_audit WHERE project_id=$1 OR project_id IS NULL ORDER BY id DESC LIMIT 100',[value.project])).rows;
  return {registration,changes,limit:100,source:'DATABASE_CONFIGURATION_WRITE',human_identity:'NOT_PROVEN',historical_backfill:false};
}
