import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {observe} from '../apps/detection.js';
import {investigation} from '../apps/investigation.js';

test('copy investigation reflects suspended and review-required clone alerts without changing queues',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='copy_notifications_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<50).sort()) await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('a','A','http://original.test'),('b','B','http://original.test')");
    for(const project of ['a','b']) await observe(db,project,'http://original.test','http://copy.test');
    const state=async(project:string)=>(await investigation(db,project))[0].notification.outbox?.state;
    assert.equal(await state('a'),'PENDING');
    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='a'");
    assert.equal(await state('a'),'SUSPENDED');assert.equal(await state('b'),'PENDING');
    await db.query("UPDATE projects SET lifecycle_state='ACTIVE' WHERE id='a'");
    assert.equal(await state('a'),'REVIEW_REQUIRED');
    await db.query("UPDATE alert_outbox SET expired_at=now() WHERE incident_id=(SELECT id FROM incidents WHERE project_id='a')");
    assert.equal(await state('a'),'EXPIRED');
    await db.query("UPDATE alert_outbox SET sent_at=now() WHERE incident_id=(SELECT id FROM incidents WHERE project_id='a')");
    assert.equal(await state('a'),'ACCEPTED_BY_TRANSPORT');
    assert.equal((await db.query('SELECT sum(attempts)::int n FROM alert_outbox')).rows[0].n,0);
  } finally {await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
