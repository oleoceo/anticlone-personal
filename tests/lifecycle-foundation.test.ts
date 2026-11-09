import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { operationallyEligible } from '../apps/operational-eligibility.js';

test('lifecycle backfill and gates preserve project and page isolation', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema = 'lifecycle_' + randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    await db.query('CREATE TABLE projects(id text PRIMARY KEY)');
    await db.query('CREATE TABLE protected_pages(id uuid PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), enabled boolean NOT NULL)');
    const a=randomUUID(), b=randomUUID(), c=randomUUID();
    await db.query("INSERT INTO projects VALUES ('health'),('finance')");
    await db.query("INSERT INTO protected_pages VALUES ($1,'health',true),($2,'health',false),($3,'finance',true)",[a,b,c]);
    await db.query(await readFile('infra/043_lifecycle.sql','utf8'));
    assert.equal(await operationallyEligible(db,'health',a),true);
    assert.equal(await operationallyEligible(db,'health',b),false);
    assert.equal((await db.query('SELECT lifecycle_state FROM protected_pages WHERE id=$1',[b])).rows[0].lifecycle_state,'PAUSED');
    const reader=await db.connect(), writer=await db.connect();
    try {
      await reader.query('BEGIN');
      assert.equal(await operationallyEligible(reader,'health',a,true),true);
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(writer.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='health'"), {code:'55P03'});
      await writer.query('ROLLBACK');
      await reader.query('COMMIT');
    } finally { reader.release(); writer.release(); }
    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='health'");
    assert.equal(await operationallyEligible(db,'health',a),false);
    assert.equal(await operationallyEligible(db,'finance',c),true);
    await db.query("UPDATE projects SET lifecycle_state='ACTIVE' WHERE id='health'");
    await db.query("UPDATE protected_pages SET lifecycle_state='PAUSED' WHERE id=$1",[a]);
    assert.equal(await operationallyEligible(db,'health',a),false);
    assert.equal(await operationallyEligible(db,'finance',c),true);
    await db.query("UPDATE projects SET lifecycle_state='ARCHIVED' WHERE id='finance'");
    assert.equal(await operationallyEligible(db,'finance',c),false);
  } finally {
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
