import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { legacyOperationallyEligible, operationallyEligible } from '../apps/operational-eligibility.js';

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
    const legacy=await db.connect();
    try {
      await legacy.query('BEGIN');
      assert.equal(await legacyOperationallyEligible(legacy,'health'),false);
      await legacy.query('ROLLBACK');
      await db.query('DELETE FROM protected_pages WHERE id=$1',[b]);
      await legacy.query('BEGIN');
      assert.equal(await legacyOperationallyEligible(legacy,'health'),true);
      await legacy.query('ROLLBACK');
      await db.query("INSERT INTO protected_pages(id,project_id,enabled,lifecycle_state) VALUES($1,'health',false,'PAUSED')",[b]);
    } finally { legacy.release(); }
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
      await db.query('CREATE TABLE work_log(project_id text NOT NULL)');
      await reader.query('BEGIN');
      assert.equal(await operationallyEligible(reader,'health',a,true),true);
      await reader.query("INSERT INTO work_log VALUES('health')");
      const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const blocked=writer.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='health'");
      let waiting=false;
      for (let n=0;n<1000 && !waiting;n++) {
        const state=await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[writerPid]);
        waiting=state.rows[0].blocked;
      }
      assert.equal(waiting,true,'pause waits for the operational transaction');
      assert.equal(await operationallyEligible(db,'finance',c),true);
      await reader.query('COMMIT');
      await blocked;
      assert.equal(await operationallyEligible(db,'health',a),false);
      assert.equal((await db.query("SELECT count(*)::int n FROM work_log WHERE project_id='health'")).rows[0].n,1);
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
