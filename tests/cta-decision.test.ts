import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { ctaDecision, publishCtaPolicy } from '../apps/cta-policy.js';

test('D07: stored forms do not consume the active anchor mapping limit', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  try {
    for (const file of ['003_projects','007_protection_policy','011_cta_inventory','012_cta_policy']) {
      await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    }
    const project = 'd07_' + crypto.randomUUID();
    const original = `http://127.0.0.1:${20000 + Math.floor(Math.random()*10000)}`;
    const clone = original.replace('127.0.0.1','localhost');
    const destination = crypto.randomUUID();
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES($1,'basic',$2,$3)",[project,destination,original+'/approved']);
    // Multiple inventory captures can accumulate over 100 mapped points on one surface.
    const addPoints = async (kind:string, count:number, prefix:string) => {
      const points = Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),marker:prefix+String(i).padStart(4,'0')}));
      await db.query(`INSERT INTO cta_points(project_id,id,surface,marker,kind,offer)
        SELECT $1,id,'landing',marker,$2,'basic' FROM jsonb_to_recordset($3::jsonb) AS point(id uuid,marker text)`,[project,kind,JSON.stringify(points)]);
      await db.query(`INSERT INTO cta_mappings(project_id,point_id,offer,destination_id)
        SELECT $1,id,'basic',$2 FROM jsonb_to_recordset($3::jsonb) AS point(id uuid)`,[project,destination,JSON.stringify(points)]);
    };
    await addPoints('a',1,'anchor');
    await publishCtaPolicy(db,project,{enabled:true,surface:'landing',pathname:'/clone',allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}});
    const decision = () => ctaDecision(db,project,original,clone,clone,'LOW','0'.repeat(32),'DIRECT_UNKNOWN');
    const baseline = await decision();
    assert.equal(baseline.action,'REPLACE_CONVERSION');
    assert.deepEqual(baseline.mappings,[{marker:'anchor0000',kind:'a',destination:original+'/approved'}]);
    await addPoints('form',101,'form');
    assert.deepEqual(await decision(),baseline);
    const stored = await db.query(`SELECT count(*)::int AS n FROM cta_mappings m JOIN cta_points p
      ON p.project_id=m.project_id AND p.id=m.point_id WHERE p.project_id=$1 AND p.kind='form'`,[project]);
    assert.equal(stored.rows[0].n,101);
    await addPoints('a',99,'extra');
    const atLimit = await decision();
    assert.equal(atLimit.action,'REPLACE_CONVERSION');
    assert.equal(atLimit.mappings?.length,100);
    assert.ok(atLimit.mappings?.every(row=>row.kind==='a'));
    await addPoints('a',1,'overflow');
    assert.deepEqual(await decision(),{action:'OBSERVE_ONLY'});
  } finally { await db.end(); }
});
