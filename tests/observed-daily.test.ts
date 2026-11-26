import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {Pool} from 'pg';
import {retainObservedMetrics} from '../apps/observed-retention.js';
import {observedDailyHistory} from '../apps/observed-activity.js';

test('daily history atomically folds eligible facts and distinguishes missing coverage', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='daily_'+crypto.randomUUID().replaceAll('-','');
  const role=schema+'_maintenance';
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema,max:2});
  await root.query('CREATE SCHEMA '+schema);
  await root.query('CREATE ROLE '+role+' NOLOGIN NOINHERIT');
  try {
    await db.query('CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),PRIMARY KEY(id,project_id))');
    for(const file of ['047_observed_metrics','074_observed_session_copy','079_observed_daily'])
      await db.query(await readFile('infra/'+file+'.sql','utf8'));
    await db.query("ALTER TABLE observed_action_facts ADD COLUMN copy_cta jsonb; INSERT INTO projects VALUES ('one'),('two')");
    await db.query(await readFile('infra/080_observed_expiry_guard.sql','utf8'));
    await db.query("UPDATE observed_daily_installation SET installed_at=statement_timestamp()-interval '5 days'");
    const page=crypto.randomUUID();
    await db.query("INSERT INTO protected_pages VALUES($1,'one')",[page]);
    await db.query(`INSERT INTO observed_action_facts(project_id,page_id,event_id,session_id,action,traffic_class,evidence,received_at,copy_cta)
      SELECT 'one',$1,gen_random_uuid(),repeat('a',32),'CTA_CLICK_OBSERVED','DIRECT_UNKNOWN','BROWSER_UNVERIFIED',
        statement_timestamp()-make_interval(days=>age),'{"origin":"https://copy.test","pathname":"/offer","marker":"checkout01","surface":"main"}'
      FROM unnest(ARRAY[8,8,100,0]) age`,[page]);
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT (project_id,page_id,received_at,action,traffic_class,evidence,copy_cta,session_copy), DELETE ON observed_action_facts TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON observed_daily_actions TO ${role};
      GRANT SELECT, INSERT, UPDATE ON observed_daily_progress TO ${role};
      GRANT EXECUTE ON FUNCTION expire_observed_facts(text) TO ${role};`);
    const retainAsMaintenance=async () => {
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE '+role);
        await retainObservedMetrics(client,'one');
        await client.query('COMMIT');
      } catch(error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {client.release();}
    };
    const denied=await db.connect();
    try {
      await denied.query('BEGIN');
      await denied.query('SET LOCAL ROLE '+role);
      await assert.rejects(denied.query('SELECT session_id FROM observed_action_facts'),{code:'42501'});
    } finally {
      await denied.query('ROLLBACK');
      denied.release();
    }
    // A rollback executable is prevented from expiring facts outside the approved path.
    await assert.rejects(db.query("DELETE FROM observed_action_facts WHERE project_id='one' AND received_at<clock_timestamp()-interval '7 days'"),/observed expiry must use consolidation/);
    await Promise.all([retainAsMaintenance(),retainAsMaintenance()]);
    await retainAsMaintenance();
    const {rows:[remaining]}=await db.query('SELECT count(*)::int n FROM observed_action_facts');
    assert.equal(remaining.n,1);
    const from=new Date(Date.now()-90*86400000).toISOString(),until=new Date().toISOString();
    const result=await observedDailyHistory(db,['one',page,from,until,null,null],{origin:'https://copy.test',pathname:'/offer'});
    assert.equal(result.coverage.length,1);
    assert.equal(result.days.length,1);
    assert.equal(result.days[0].events,'2');
    assert.deepEqual(result.points,[{copy_origin:'https://copy.test',copy_path:'/offer',marker:'checkout01',surface:'main',clicks:'2'}]);
    assert.deepEqual(result.copies,[{origin:'https://copy.test',pathname:'/offer'}]);
    const {rows:[point]}=await db.query('SELECT marker,surface,events FROM observed_daily_actions');
    assert.deepEqual(point,{marker:'checkout01',surface:'main',events:'2'});
    assert.equal('sessions' in result.days[0],false);
    const absent=await observedDailyHistory(db,['two',null,from,until,null,null],null);
    assert.deepEqual(absent.coverage,[]);
    assert.deepEqual(absent.days,[]);
  } finally {
    await db.end();
    await root.query('DROP SCHEMA '+schema+' CASCADE');
    await root.query('DROP ROLE '+role);
    await root.end();
  }
});
