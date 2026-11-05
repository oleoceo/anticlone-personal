import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { approveCommercial, approveDestination, importInventory, mapPoint, reviewPoint } from '../apps/cta-inventory.js';
import { ctaDecision, publishCtaPolicy } from '../apps/cta-policy.js';

test('commercial drift is isolated, deduplicated and approved against current evidence', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='commercial_'+randomUUID().replaceAll('-','');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    for(const file of ['001_initial','002_alerts','003_projects','007_protection_policy','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','023_cta_commercial']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    const project='commercial_lab', origin='http://127.0.0.1:1234', clone='http://localhost:1234';
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,origin]);
    const rows=(a:number|null,b=9700)=>[{marker:'basic001',kind:'a',parent:'body',ordinal:1,url:clone+'/a',commercial:a===null?null:{amount:a,currency:'BRL'}},{marker:'premium1',kind:'a',parent:'body',ordinal:2,url:clone+'/b',commercial:{amount:b,currency:'BRL'}}];
    const capture=async(a:number|null)=>importInventory(db,project,{surface:'landing',candidates:rows(a)});
    await capture(6700);
    const points=(await db.query('SELECT id,marker FROM cta_points')).rows;
    const dest:Record<string,string>={};
    for(const point of points) {
      const offer=point.marker==='basic001'?'a':'b';
      dest[point.marker]=(await approveDestination(db,project,{offer,url:origin+'/'+offer})).id;
      await mapPoint(db,project,{pointId:point.id,offer,destinationId:dest[point.marker]});
    }
    const approval=async(marker:string,version:number)=>{
      const result=await db.query(`SELECT o.id,o.capture_id,o.commercial_amount,o.commercial_currency,p.id AS point FROM cta_observations o JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id JOIN cta_captures c ON c.id=o.capture_id WHERE p.marker=$1 AND c.is_current`,[marker]);
      const x=result.rows[0]; return {project,surface:'landing',pointId:x.point,captureId:x.capture_id,observationId:x.id,destinationId:dest[marker],amount:Number(x.commercial_amount),currency:x.commercial_currency,version};
    };
    await approveCommercial(db,await approval('basic001',0)); await approveCommercial(db,await approval('premium1',0));
    await publishCtaPolicy(db,project,{enabled:true,surface:'landing',pathname:'/clone',allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}});
    const decision=()=>ctaDecision(db,project,origin,clone,clone,'LOW','a'.repeat(32),'DIRECT_UNKNOWN');
    assert.equal((await decision()).mappings?.length,2);
    await capture(8900); await capture(8900);
    assert.deepEqual((await db.query('SELECT reason FROM cta_drift_alerts')).rows,[{reason:'COMMERCIAL_CHANGED'}]);
    assert.deepEqual((await decision()).mappings?.map(x=>x.marker),['premium1']);
    const stale=await approval('basic001',1); await capture(8900);
    await assert.rejects(approveCommercial(db,stale));
    const current=await approval('basic001',1);
    const concurrent=await Promise.allSettled([approveCommercial(db,current),approveCommercial(db,current)]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((await decision()).mappings?.length,2);
    await capture(null);
    assert.equal((await db.query("SELECT suspension FROM cta_commercial_references r JOIN cta_points p ON p.project_id=r.project_id AND p.id=r.point_id WHERE p.marker='basic001'")).rows[0].suspension,'UNCERTAIN');
    assert.deepEqual((await decision()).mappings?.map(x=>x.marker),['premium1']);
    await assert.rejects(approveCommercial(db,await approval('basic001',2)));
    const changedCurrency=rows(8900); changedCurrency[0].commercial!.currency='USD';
    await importInventory(db,project,{surface:'landing',candidates:changedCurrency});
    assert.equal((await db.query("SELECT suspension FROM cta_commercial_references r JOIN cta_points p ON p.project_id=r.project_id AND p.id=r.point_id WHERE p.marker='basic001'")).rows[0].suspension,'CHANGED');
    const usd=await approval('basic001',2);
    await assert.rejects(approveCommercial(db,{...usd,project:'wrong'}));
    await db.query("UPDATE cta_points SET review_required=true WHERE project_id=$1 AND marker='basic001'",[project]);
    await reviewPoint(db,project,{pointId:usd.pointId,destinationId:usd.destinationId,observationId:usd.observationId});
    assert.deepEqual((await decision()).mappings?.map(x=>x.marker),['premium1']);
    await db.query("UPDATE cta_points SET review_required=true WHERE project_id=$1 AND marker='basic001'",[project]);
    await approveCommercial(db,usd);
    assert.deepEqual((await decision()).mappings?.map(x=>x.marker),['premium1']);
    assert.equal((await db.query("SELECT review_required FROM cta_points WHERE project_id=$1 AND marker='basic001'",[project])).rows[0].review_required,true);
    await capture(9000);
    const race=await approval('basic001',3);
    await Promise.allSettled([approveCommercial(db,race),capture(10000)]);
    assert.ok((await db.query("SELECT suspension FROM cta_commercial_references r JOIN cta_points p ON p.project_id=r.project_id AND p.id=r.point_id WHERE p.marker='basic001'")).rows[0].suspension);
    assert.deepEqual((await decision()).mappings?.map(x=>x.marker),['premium1']);
  } finally { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
