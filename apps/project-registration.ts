import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {configuredOrigin} from './detection.js';

// Both authenticated entry points use this transaction. Audit failure must fail
// creation; no session token, MFA code or network identifier belongs in history.
export async function registerProject(db:Pool, input:unknown) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid project');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='name,origin' || typeof value.name!=='string' || !value.name.trim() || value.name.length>100 || typeof value.origin!=='string') throw new TypeError('invalid project');
  let origin:string;
  try {origin=configuredOrigin(value.origin);} catch {throw new TypeError('invalid origin');}
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query('INSERT INTO projects(id,name,origin) VALUES($1,$2,$3) RETURNING id,name,origin',[randomUUID(),value.name.trim(),origin])).rows[0];
    await client.query('INSERT INTO project_registration_audit(project_id,name,origin) VALUES($1,$2,$3)',[row.id,row.name,row.origin]);
    await client.query('COMMIT');return row;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

export async function registrationHistory(db:Pool,input:unknown) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid history');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='project' || typeof value.project!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.project)) throw new TypeError('invalid project');
  const registration=(await db.query('SELECT id,project_id,name,origin,occurred_at,actor,action FROM project_registration_audit WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[value.project])).rows;
  const changes=(await db.query('SELECT * FROM administrative_change_audit WHERE project_id=$1 OR project_id IS NULL ORDER BY id DESC LIMIT 100',[value.project])).rows;
  return {registration,changes,limit:100,source:'DATABASE_CONFIGURATION_WRITE',human_identity:'NOT_PROVEN',historical_backfill:false};
}
