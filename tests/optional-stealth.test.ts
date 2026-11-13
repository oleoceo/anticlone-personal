import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {entryProbe} from './entry-probe.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {publishPagePolicy} from '../apps/protection-admin.js';
import {publishCtaPolicy,ctaDecision} from '../apps/cta-policy.js';
import {managePages,PageConflict} from '../apps/protected-pages.js';
import {saveDraft,activatePolicy,validateDraft} from '../apps/protection-policy.js';
import {permitsMitigation} from '../apps/stealth.js';
import {evaluateRisk,assessObservation,preserveLegacyRiskHistory} from '../apps/risk.js';

const allocation={PAID_ATTRIBUTED:100,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0};
test('versioned Stealth rejects ambiguity and does not fabricate operator evidence',async()=>{
  const decision={action:'PAGE_REDIRECT',stealthVersion:2};
  assert.deepEqual(await preserveLegacyRiskHistory(decision,new Promise<boolean>(()=>{})),decision);
  assert.deepEqual(await preserveLegacyRiskHistory({action:'PAGE_REDIRECT'},Promise.resolve(false)),{action:'OBSERVE_ONLY'});
  for(const stealth of [true,false]) {
    for(const risk of ['LOW','HIGH','UNCERTAIN',undefined]) {
      assert.equal(permitsMitigation({stealth_version:2,stealth},risk),true);
    }
  }
  assert.equal(permitsMitigation({stealth_version:2,stealth:true},'HIGH',{...evaluateRisk(true),level:'HIGH'}),false);
  for(const value of [{stealth:false},{stealth:true,stealth_version:null},{stealth:true,stealth_version:3},{stealth:'OFF',stealth_version:2}]) {
    assert.throws(()=>validateDraft({enabled:true,approved_destination:'http://localhost/a',allocation,...value},'http://localhost'));
  }
  for(const kind of ['none','paid_utm'] as const) assert.equal(assessObservation({source:'browser',reliability:'uncorroborated',trafficClass:'DIRECT_UNKNOWN',kind},false).level,'UNCERTAIN');
});

test('GS05/GS19 optional Stealth: PostgreSQL and Chromium, two projects/two LPs, legacy migration and fail-open',{timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='optional_stealth_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const pages=[{project:'alpha',page:randomUUID(),installation:randomUUID(),path:'/one'},{project:'beta',page:randomUUID(),installation:randomUUID(),path:'/two'}];
  let gatewayOrigin='';
  const fixture=createServer((req,res)=>{
    const item=pages.find(p=>p.path===req.url?.split('?')[0]);
    res.writeHead(200,{'content-type':'text/html'}).end(item?`<a data-anticlone-surface="main" data-anticlone-point="checkout01" href="/native">Checkout</a><script src="${gatewayOrigin}/i/${item.installation}/runtime.js"></script>`:'<h1>Destination</h1>');
  }).listen(0,'127.0.0.1');await once(fixture,'listening');const addr=fixture.address();assert.ok(addr&&typeof addr!=='string');
  const original=`http://127.0.0.1:${addr.port}`,copy=`http://localhost:${addr.port}`;
  const saved={...process.env};let server:ReturnType<typeof createServer>|undefined;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<50).sort()) await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    for(const p of pages) {
      await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[p.project,original]);
      await db.query('INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,$2,$3,$2)',[p.page,p.project,p.installation]);
      await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[p.page,original,p.path]);
      const point=randomUUID(),destination=randomUUID();
      await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES($1,$2,'main','checkout01','a','offer')",[p.project,point]);
      await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES($1,'offer',$2,$3)",[p.project,destination,original+'/'+p.project+'-cta']);
      await db.query("INSERT INTO cta_mappings VALUES($1,$2,'offer',$3)",[p.project,point,destination]);
    }
    const approve=async(p:typeof pages[number],entryVersion:number|null,ctaVersions:number[])=>{
      const row=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[p.page])).rows[0];
      await managePages(db,{action:'approve',project:p.project,page:p.page,generation:row.url_generation,configGeneration:row.config_generation,entryVersion,ctaVersions});
    };
    // Existing published versions and their approval must survive the migration unchanged.
    const legacy=await publishCtaPolicy(db,'alpha',{enabled:true,surface:'main',pathname:'/one',allocation});await approve(pages[0],null,[legacy]);
    const before=(await db.query('SELECT configuration FROM page_policy_approvals')).rows;
    await db.query(await readFile('infra/050_optional_stealth.sql','utf8'));
    assert.deepEqual((await db.query('SELECT configuration FROM page_policy_approvals')).rows,before);
    assert.equal((await db.query('SELECT stealth_version FROM cta_policy_versions')).rows[0].stealth_version,null);
    process.env.SCOPED_LAB_INSTALLATIONS=pages.map(p=>p.installation).join(',');process.env.SCOPED_LAB_ORIGIN=copy;delete process.env.GATEWAY_MODE;
    const scripts=Object.fromEntries(await Promise.all([['runtime.js','bootstrap.js'],['core.js','core.js'],['fallback.js','fallback.js']].map(async([name,file])=>[name,await readFile('runtime/'+file)])));
    const handle=scopedGateway(db,scripts,async()=>true);
    server=createServer((req,res)=>{if(!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(server,'listening');const ga=server.address();assert.ok(ga&&typeof ga!=='string');gatewayOrigin=`http://127.0.0.1:${ga.port}`;
    const decide=async(p:typeof pages[number],paid=true,endpoint='entry-decision',origin=copy)=>{
      const result=await fetch(`${gatewayOrigin}/i/${p.installation}/${endpoint}`,{method:'POST',headers:{origin,'content-type':'text/plain'},body:JSON.stringify({pathname:p.path,session:'a'.repeat(32),signals:paid?{medium:'cpc'}:{}})});
      return await result.json() as {action:string;destination?:string;mappings?:{destination:string}[]};
    };
    process.env.SCOPED_LAB_RISK='LOW';assert.equal((await decide(pages[0])).action,'REPLACE_CONVERSION');
    process.env.SCOPED_LAB_RISK='UNCERTAIN';assert.equal((await decide(pages[0])).action,'OBSERVE_ONLY');
    const publish=async(p:typeof pages[number],pageStealth:boolean,ctaStealth:boolean,pageEnabled=true)=>{
      const entry=await publishPagePolicy(db,p.project,{enabled:pageEnabled,approved_destination:original+'/'+p.project+'-page',stealth:pageStealth,stealth_version:2,allocation});
      const cta=await publishCtaPolicy(db,p.project,{enabled:true,surface:'main',pathname:p.path,stealth:ctaStealth,stealth_version:2,allocation});
      // Merely publishing cannot migrate a page approval.
      assert.equal((await decide(p)).action,'OBSERVE_ONLY');
      await approve(p,pageEnabled?entry.version:null,[cta]);return {entry:entry.version,cta};
    };
    await publish(pages[0],false,false);await publish(pages[1],false,false);
    for(const risk of ['LOW','HIGH','UNCERTAIN','ERROR']) {
      process.env.SCOPED_LAB_RISK=risk;
      for(const p of pages) {
        assert.equal((await decide(p)).destination,original+'/'+p.project+'-page');
        assert.equal((await decide(p,false)).action,'OBSERVE_ONLY');
        assert.equal((await decide(p,true,'cta-refresh')).mappings?.[0].destination,original+'/'+p.project+'-cta');
        assert.equal((await decide(p,true,'entry-decision',original)).action,'OBSERVE_ONLY');
        assert.equal((await decide(p,true,'entry-decision','https://unapproved.test')).action,'OBSERVE_ONLY');
      }
    }
    await db.query('ALTER TABLE risk_assessment_days RENAME TO unavailable_risk');
    try { assert.equal((await decide(pages[0])).action,'PAGE_REDIRECT'); } finally { await db.query('ALTER TABLE unavailable_risk RENAME TO risk_assessment_days'); }
    await publish(pages[0],true,true);process.env.SCOPED_LAB_RISK='HIGH';
    assert.equal((await decide(pages[0])).action,'OBSERVE_ONLY');assert.equal((await decide(pages[0],true,'cta-refresh')).action,'OBSERVE_ONLY');
    assert.equal((await decide(pages[1])).action,'PAGE_REDIRECT');
    process.env.SCOPED_LAB_RISK='UNCERTAIN';assert.equal((await decide(pages[0])).action,'PAGE_REDIRECT');assert.equal((await decide(pages[0],true,'cta-refresh')).action,'REPLACE_CONVERSION');
    // Page and CTA settings have independent authority.
    await publish(pages[0],true,false);process.env.SCOPED_LAB_RISK='HIGH';assert.equal((await decide(pages[0])).action,'REPLACE_CONVERSION');
    await publish(pages[0],false,true);assert.equal((await decide(pages[0])).action,'PAGE_REDIRECT');assert.equal((await decide(pages[0],true,'cta-refresh')).action,'OBSERVE_ONLY');
    // Draft migration and rollback preserve the explicit version contract.
    await saveDraft(db,'alpha',{enabled:true,approved_destination:original+'/draft',stealth:false,stealth_version:2,allocation});const v=await activatePolicy(db,'alpha');await activatePolicy(db,'alpha',v);
    await saveDraft(db,'alpha',{enabled:true,approved_destination:original+'/legacy',stealth:true,allocation});const old=await activatePolicy(db,'alpha');assert.equal((await db.query('SELECT stealth_version FROM protection_policy_versions WHERE project_id=$1 AND version=$2',['alpha',old])).rows[0].stealth_version,null);
    await publish(pages[0],false,false,false);process.env.SCOPED_LAB_RISK='UNCERTAIN';
    browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    const context=await browser.newContext();await context.addInitScript(()=>sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify({medium:'cpc'})));
    const page=await context.newPage();const response=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));await page.goto(copy+'/one');assert.equal((await (await response).json()).action,'REPLACE_CONVERSION');
    await page.waitForTimeout(100);let clickNetwork=0;await page.route('**/cta-refresh',r=>{clickNetwork++;return r.abort();});await page.locator('a').click();await page.waitForURL(original+'/alpha-cta');assert.equal(clickNetwork,0);
    await page.goto(original+'/one');await page.waitForTimeout(200);assert.equal(page.url(),original+'/one');await page.locator('a').click();await page.waitForURL(original+'/native');
    await page.route('**/entry-decision',r=>r.abort());await page.goto(copy+'/one');await page.waitForTimeout(250);assert.equal(page.url(),copy+'/one');await page.locator('a').click();await page.waitForURL(copy+'/native');
    await page.unroute('**/entry-decision');await page.unroute('**/cta-refresh');
    // Observe real timing, force a late negative, and prove the policy positive
    // independently of runner throughput. All decisions come from PostgreSQL.
    for(const mode of ['real','late','controlled','original'] as const) {
      const betaContext=await browser.newContext();
      await betaContext.addInitScript(()=>sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify({medium:'cpc'})));
      const beta=await betaContext.newPage();
      if(mode==='controlled'){await beta.clock.install();await beta.clock.pauseAt(new Date());}
      const probe=await entryProbe(beta);
      if(mode==='late')await betaContext.route('**/entry-decision',async route=>{
        const upstream=await route.fetch({maxRedirects:0}),body=await upstream.body();
        await new Promise(resolve=>setTimeout(resolve,250));
        await route.fulfill({response:upstream,body});
      });
      // Prove CTA readiness is observed, rather than assumed after 100 ms.
      if(mode==='late')await betaContext.route('**/cta-refresh',async route=>{
        const upstream=await route.fetch({maxRedirects:0}),body=await upstream.body();
        await new Promise(resolve=>setTimeout(resolve,250));
        await route.fulfill({response:upstream,body});
      });
      try {
        await beta.goto((mode==='original'?original:copy)+'/two');const result=await probe.parsed;
        if(mode==='original') {
          assert.equal(result.decision.action,'OBSERVE_ONLY','authorized origin must reject mitigation');
          assert.equal(beta.url(),original+'/two');
          await beta.locator('a').click();await beta.waitForURL(original+'/native');continue;
        }
        assert.equal(result.decision.action,'PAGE_REDIRECT','policy must permit beta independently of latency');
        assert.equal(result.decision.destination,original+'/beta-page');
        const armed=probe.events.find(e=>e.event==='deadline-armed');assert.ok(armed);
        const late=result.mono>=Number(armed.deadline)||probe.events.some(e=>e.event==='deadline-expired');
        if(mode==='late')assert.ok(late,'injected delay must exceed the real browser budget');
        if(mode==='controlled')assert.equal(late,false);
        if(late) {
          await beta.waitForTimeout(100);assert.ok(probe.events.some(e=>e.event==='deadline-expired'));
          assert.equal(beta.url(),copy+'/two','late PAGE must preserve the copy');
          await probe.ctaReady();
          await beta.locator('a').click();await beta.waitForURL(original+'/beta-cta');
        } else await beta.waitForURL(original+'/beta-page');
      } finally {
        process.stdout.write('OPTIONAL_ENTRY_TIMING '+JSON.stringify({mode,browser:browser.version(),events:probe.events,finalUrl:beta.url()})+'\n');
        await betaContext.close();
      }
    }
    await context.close();
    // A partial migration must be rejected before risk selection; no legacy
    // history prerequisite may condition OFF mappings in the same envelope.
    const legacySurface=await publishCtaPolicy(db,'alpha',{enabled:true,surface:'legacy',pathname:'/one',allocation});
    const point=randomUUID(),dest=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('alpha',$1,'legacy','legacy01','a','legacy')",[point]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES('alpha','legacy',$1,$2)",[dest,original+'/legacy-cta']);
    await db.query("INSERT INTO cta_mappings VALUES('alpha',$1,'legacy',$2)",[point,dest]);
    const mainVersion=(await db.query("SELECT version FROM active_cta_surface_policies WHERE project_id='alpha' AND surface='main'")).rows[0].version as number;
    await assert.rejects(approve(pages[0],null,[mainVersion,legacySurface]),PageConflict);
    for(const risk of ['LOW','HIGH','UNCERTAIN']) assert.equal((await ctaDecision(db,'alpha',original,copy,copy,risk,'a'.repeat(32),'PAID_ATTRIBUTED','/one')).action,'OBSERVE_ONLY');
    const migrated=await publishCtaPolicy(db,'alpha',{enabled:true,surface:'legacy',pathname:'/one',stealth:false,stealth_version:2,allocation});
    await approve(pages[0],null,[mainVersion,migrated]);
    for(const risk of ['LOW','HIGH','UNCERTAIN']) {
      const result=await ctaDecision(db,'alpha',original,copy,copy,risk,'a'.repeat(32),'PAID_ATTRIBUTED','/one');
      assert.equal(result.mappings?.length,2);assert.equal(result.stealthVersion,2);
      assert.equal((await preserveLegacyRiskHistory(result,new Promise<boolean>(()=>{}))).action,'REPLACE_CONVERSION');
      assert.equal((await preserveLegacyRiskHistory(result,Promise.resolve(false))).action,'REPLACE_CONVERSION');
    }

    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='alpha'");assert.equal((await decide(pages[0])).action,'OBSERVE_ONLY');assert.equal((await decide(pages[1])).action,'PAGE_REDIRECT');
    const risks=await db.query('SELECT DISTINCT level FROM risk_assessment_days');assert.ok(risks.rows.some(r=>r.level==='UNCERTAIN'));assert.ok(risks.rows.some(r=>r.level==='HIGH'));
  } finally {
    process.env=saved;if(browser)await browser.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await new Promise<void>(resolve=>fixture.close(()=>resolve()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
