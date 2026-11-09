import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { operationallyEligible, legacyOperationallyEligible } from '../apps/operational-eligibility.js';
import { notificationAdmission } from '../apps/notification-lifecycle.js';

test('eligibility admits explicit pre-projects schemas but propagates catalog failures and enforces lifecycle', async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='eligibility_'+randomUUID().replaceAll('-','');
 await root.query(`CREATE SCHEMA ${schema}`);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 const client=await db.connect();
 try {
  await assert.rejects(operationallyEligible(db,'health'),/project catalog unavailable/);
  await db.query(await readFile('infra/001_initial.sql','utf8'));
  assert.equal(await operationallyEligible(db,'health'),true);
  assert.equal(await operationallyEligible(db,'health',randomUUID()),false);
  await client.query('BEGIN');
  assert.equal(await legacyOperationallyEligible(client,'health'),true);
  assert.equal(await notificationAdmission(client,'health'),null);
  await client.query('ROLLBACK');
  await db.query(await readFile('infra/003_projects.sql','utf8'));
  assert.equal(await operationallyEligible(db,'missing'),false);
  await db.query("INSERT INTO projects VALUES('health','Health','https://owner.test'); ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
  for(const state of ['ACTIVE','PAUSED','ARCHIVED']) {
   await db.query('UPDATE projects SET lifecycle_state=$1',[state]);
   await client.query('BEGIN');
   assert.equal(await operationallyEligible(client,'health',undefined,true),state==='ACTIVE');
   if(state!=='ACTIVE') assert.equal(await notificationAdmission(client,'health'),false);
   await client.query('ROLLBACK');
  }
  await db.query('CREATE TABLE notification_pause_history(project_id text); ALTER TABLE projects RENAME TO unavailable_projects');
  await assert.rejects(operationallyEligible(db,'health'),/project catalog unavailable/);
  await client.query('BEGIN'); await client.query('SELECT 1/0').catch(()=>{});
  await assert.rejects(operationallyEligible(client,'health'),{code:'25P02'});
  await client.query('ROLLBACK');
 }finally {await client.query('ROLLBACK');client.release();await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
