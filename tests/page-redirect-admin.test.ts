import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { pageRedirectAdmin } from '../apps/page-redirect-admin.js';
import { managePages } from '../apps/protected-pages.js';
import { distributionAdmin } from '../apps/runtime-distribution.js';

test('scoped redirect activation, revision and deactivation preserve the other LP', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='redirect_admin_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  try {
    for (const file of (await readdir('infra')).filter(f=>/^\d{3}_.+\.sql$/.test(f)).sort()) {
      await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    }
    const project='owned', original='https://owner.test', gateway='https://gateway.test';
    const env={RUNTIME_PUBLIC_ORIGIN:gateway,ADMIN_OPERATIONAL_GATEWAY_ORIGIN:gateway};
    let mode:'OPERATIONAL'|'OBSERVATION_ONLY'='OBSERVATION_ONLY';
    const run=(body:object)=>pageRedirectAdmin(db,{project,...body},env,async()=>mode);
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    const firstResult=await managePages(db,{project,action:'create',name:'First',url:original+'/'});
    const secondResult=await managePages(db,{project,action:'create',name:'Second',url:original+'/second'});
    assert.ok('page' in firstResult && typeof firstResult.page==='string');
    assert.ok('page' in secondResult && typeof secondResult.page==='string');
    const {page:first}=firstResult, {page:second}=secondResult;
    for (const page of [first,second]) await distributionAdmin(db,{project,page,action:'publish'},env);
    const inspect=async(page:string)=>{
      const result=await run({page,action:'inspect'});
      assert.ok('gateway' in result);
      return result;
    };
    const activate=async(page:string,copyPathname:string,copyOrigin='https://copy.test')=>{
      const {authorization,approvalId,urlGeneration,configGeneration}=await inspect(page);
      return run({action:'activate',page,approvalId,urlGeneration,configGeneration,revision:authorization?.revision??0,
        copyOrigin,copyPathname,acknowledged:true,policy:{destination:original+'/',stealth:false,
          allocation:{DIRECT_UNKNOWN:100,PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0}}});
    };

    await assert.rejects(activate(first,'/'),/public gateway unavailable/);
    mode='OPERATIONAL';
    await assert.rejects(activate(first,'/',original),/original context forbidden/);
    await activate(second,'/second');
    const sibling=await inspect(second);
    assert.equal(sibling.active,true);
    assert.equal((await activate(first,'/')).version,2);
    assert.deepEqual(await inspect(second),sibling);
    const active=await inspect(first);
    assert.equal(active.active,true);
    assert.equal(active.entry.allocation.DIRECT_UNKNOWN,100);
    await assert.rejects(run({action:'deactivate',page:first,approvalId:active.approvalId,revision:0,
      urlGeneration:active.urlGeneration,configGeneration:active.configGeneration}),/redirect changed/);
    await run({action:'deactivate',page:first,approvalId:active.approvalId,revision:active.authorization!.revision,
      urlGeneration:active.urlGeneration,configGeneration:active.configGeneration});
    assert.equal((await inspect(first)).active,false);
    assert.deepEqual(await inspect(second),sibling);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM active_protection_policies')).rows[0].n,0);
  } finally {
    await db.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
