import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { copyRedirectAdmission } from '../apps/page-redirect-rules.js';
import { pageRedirectAdmin } from '../apps/page-redirect-admin.js';
import { managePages } from '../apps/protected-pages.js';
import { listCopyContexts, recordCopyBrowserOutcome, recordCopyDecision } from '../apps/page-copy-contexts.js';
import { distributionAdmin } from '../apps/runtime-distribution.js';

test('scoped redirect activation, revision and deactivation preserve the other LP', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='redirect_admin_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  try {
    for (const file of (await readdir('infra')).filter(f=>/^\d{3}_.+\.sql$/.test(f) && Number(f.slice(0,3))<=70).sort()) {
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
    const activation=await activate(first,'/');
    assert.ok('version' in activation);
    assert.equal(activation.version,2);
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
    await db.query(await readFile('infra/071_page_copy_contexts.sql','utf8'));
    const context={project,page:first,origin:'https://timing.test',pathname:'/timing'};
    const oldVisit='1'.repeat(32), newVisit='2'.repeat(32);
    const oldAt=Date.now();
    await db.query('INSERT INTO page_copy_contexts(project_id,page_id,copy_origin,copy_pathname) VALUES($1,$2,$3,$4)',
      [context.project,context.page,context.origin,context.pathname]);
    await recordCopyDecision(db,context,{receivedAt:oldAt,visit:oldVisit,action:'OBSERVE_ONLY',reason:'ALLOCATION',version:1});
    for (const phase of ['REDIRECT_HANDOFF','PAGE_LEFT','TIMEOUT']) {
      await recordCopyBrowserOutcome(db,context,context.origin,{pathname:context.pathname,visit:newVisit,phase,
        elapsed:phase==='TIMEOUT'?150:90});
    }
    await recordCopyDecision(db,context,{receivedAt:oldAt+1,visit:newVisit,action:'PAGE_REDIRECT',reason:'REDIRECT_SELECTED',version:2});
    const client=await db.connect();
    try {
      const [timing]=await listCopyContexts(client,project,first) ?? [];
      assert.equal(timing.browser_correlated,true);
      assert.equal(timing.browser_phase,'PAGE_LEFT');
      assert.equal(timing.elapsed_ms,90);
    } finally {client.release();}
    await db.query('DELETE FROM page_copy_contexts WHERE project_id=$1 AND page_id=$2',[project,first]);
    await assert.rejects(activate(first,'/'),/COPY_REVIEW_EXPIRED/);
    const firstInstallation=(await db.query('SELECT installation_id FROM protected_pages WHERE id=$1',[first])).rows[0].installation_id;
    const secondInstallation=(await db.query('SELECT installation_id FROM protected_pages WHERE id=$1',[second])).rows[0].installation_id;
    const defaultDestination='https://destination.test/path?campaign=a';
    const overrideDestination='https://alternate.test/offer';
    const saveDefault=(destination:string,revision:number, acknowledged=true)=>run({page:first,action:'save-default',destination,revision,acknowledged});
    await assert.rejects(saveDefault('http://destination.test/',0),/invalid redirect destination/);
    await assert.rejects(saveDefault('https://user:secret@destination.test/',0),/invalid redirect destination/);
    await assert.rejects(saveDefault(defaultDestination,0,false),/explicit confirmation required/);
    await saveDefault(defaultDestination,0);
    await assert.rejects(saveDefault(overrideDestination,0),/project destination changed/);
    const saveCopy=async(copyOrigin:string,copyPathname:string,destination:string|null,revision=0,defaultRevision:number|null=1)=>{
      const {urlGeneration,configGeneration}=await inspect(first);
      const prepared=await run({page:first,action:'review-copy',copyOrigin,copyPathname,revision,defaultRevision:destination===null?defaultRevision:null,
        urlGeneration,configGeneration,policy:{destination,stealth:false,
          allocation:{DIRECT_UNKNOWN:100,PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0}}});
      assert.ok('reviewId' in prepared);
      return run({page:first,action:'confirm-copy',reviewId:prepared.reviewId});
    };
    await assert.rejects(saveCopy(original,'/',null),/original context forbidden/);
    await assert.rejects(saveCopy('https://copy.test','/',null),/COPY_CONTEXT_REQUIRED/);
    await db.query("INSERT INTO page_copy_contexts(project_id,page_id,copy_origin,copy_pathname) VALUES($1,$2,'https://copy.test','/'),($1,$2,'https://copy.test','/second-copy')",[project,first]);
    await assert.rejects(saveCopy('https://copy.test','/',null,0,0),/project destination changed/);
    await saveCopy('https://copy.test','/',null);
    await saveCopy('https://copy.test','/second-copy',overrideDestination);
    const snapshot=await inspect(first);
    const prepared=await run({page:first,action:'review-copy',copyOrigin:'https://copy.test',copyPathname:'/second-copy',revision:1,defaultRevision:null,
      urlGeneration:snapshot.urlGeneration,configGeneration:snapshot.configGeneration,
      policy:{destination:overrideDestination,stealth:false,allocation:{DIRECT_UNKNOWN:100,PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0}}});
    assert.ok('reviewId' in prepared);
    const confirmation={action:'confirm-copy',reviewId:prepared.reviewId};
    await assert.rejects(run({...confirmation,page:second}),/COPY_REVIEW_EXPIRED/);
    await assert.rejects(run({...confirmation,page:first,destination:'https://injected.test/'}),/invalid confirmation/);
    await run({...confirmation,page:first});
    await assert.rejects(run({...confirmation,page:first}),/COPY_REVIEW_EXPIRED/);

    const inherited=()=>copyRedirectAdmission(db,firstInstallation,'https://copy.test','/');
    const customized=()=>copyRedirectAdmission(db,firstInstallation,'https://copy.test','/second-copy');
    assert.equal((await inherited())?.approved_destination,defaultDestination);
    assert.equal((await customized())?.approved_destination,overrideDestination);
    assert.equal((await inherited())?.admitted,true);
    assert.equal(await copyRedirectAdmission(db,firstInstallation,'https://wrong.test','/'),null);
    assert.equal(await copyRedirectAdmission(db,secondInstallation,'https://copy.test','/'),null);
    assert.equal(await copyRedirectAdmission(db,firstInstallation,'https://copy.test','/wrong'),null);
    await assert.rejects(saveDefault('https://copy.test/loop',1),/PROJECT_DESTINATION_ON_COPY/);
    const beforeDefaultChange=await inherited();
    await saveDefault('https://new-destination.test/',1);
    assert.notEqual((await inherited())?.version,beforeDefaultChange?.version);
    assert.equal((await inherited())?.approved_destination,'https://new-destination.test/');
    assert.equal((await customized())?.approved_destination,overrideDestination);
    await run({page:first,action:'disable-copy',copyOrigin:'https://copy.test',copyPathname:'/',revision:2});
    assert.equal((await inherited())?.admitted,false);
    assert.equal((await customized())?.admitted,true);
    await saveCopy('https://copy.test','/',null,3,2);
    assert.equal((await inherited())?.admitted,true);
    await db.query('UPDATE protected_pages SET url_generation=url_generation+1 WHERE id=$1',[first]);
    assert.equal((await inherited())?.admitted,false);
    assert.equal((await customized())?.admitted,false);
    await saveCopy('https://copy.test','/second-copy',overrideDestination,2);
    assert.equal((await customized())?.admitted,true);
    await db.query("INSERT INTO projects(id,name,origin) VALUES('other','Other','https://copy.test')");
    assert.equal((await customized())?.admitted,false);
    assert.equal((await inspect(first)).rules?.rules.find(rule=>rule.copy_pathname==='/second-copy')?.copy_is_official,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM administrative_change_audit WHERE relation_name='page_redirect_rules'")).rows[0].n,7);
    await assert.rejects(db.query('DELETE FROM project_redirect_destinations'),/immutable/);

  } finally {
    await db.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
