import {issueObservedReceipt} from '../apps/observed-receipts.js';
import {createServer} from 'node:http';
import {observedSessionGateway} from '../apps/observed-session-gateway.js';
import {once} from 'node:events';
import {scryptSync} from 'node:crypto';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {createAdminServer} from '../apps/admin-auth.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {recordObservedFact,configureEstimate,observedMetrics,type ObservedFact} from '../apps/observed-metrics.js';

test('observed metrics persist idempotently, isolate pages and separate estimates from sales',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='metrics_'+crypto.randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
 let db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{
  await db.query('CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(id,project_id))');
  await db.query(await readFile('infra/047_observed_metrics.sql','utf8'));
  await db.query(await readFile('infra/048_observed_receipts.sql','utf8'));
  await db.query('ALTER TABLE protected_pages ADD COLUMN installation_id uuid; CREATE TABLE protected_page_urls(page_id uuid,origin text,pathname text)');
  const page=crypto.randomUUID(),other=crypto.randomUUID();
  await db.query("INSERT INTO projects VALUES('one'),('two');");
  await db.query("INSERT INTO protected_pages(id,project_id) VALUES($1,'one'),($2,'two')",[page,other]);
  const from=new Date(Date.now()-60000).toISOString(),until=new Date(Date.now()+60000).toISOString();
  assert.equal((await observedMetrics(db,'one',page,from,until)).estimate,null);
  const fact:ObservedFact={page,event:crypto.randomUUID(),session:'a'.repeat(32),action:'CTA_CLICK_OBSERVED',traffic:'PAID_ATTRIBUTED',version:1,evidence:'BROWSER_UNVERIFIED'};
  const results=await Promise.all(Array.from({length:8},()=>recordObservedFact(db,'one',fact)));
  assert.equal(results.filter(r=>!r.duplicate).length,1);
  await assert.rejects(recordObservedFact(db,'one',{...fact,action:'PAGE_REDIRECT_ATTEMPT'}),TypeError);
  await assert.rejects(recordObservedFact(db,'two',{...fact,event:crypto.randomUUID()}));
  await configureEstimate(db,'one',10000,250,'BRL');
  await configureEstimate(db,'two',10000,250,'BRL');
  await recordObservedFact(db,'two',{...fact,page:other,event:crypto.randomUUID(),action:'SESSION_OBSERVED',version:null});
  assert.equal((await observedMetrics(db,'two',other,from,until)).estimate,null);
  await db.end(); db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  assert.equal((await recordObservedFact(db,'one',fact)).duplicate,true);
  let summary=await observedMetrics(db,'one',page,from,until);
  assert.equal(summary.rows[0].events,1);assert.equal(summary.rows[0].sessions,1);
  assert.equal(summary.estimate?.amount_minor_numerator,'2500000');assert.equal(summary.recovered_revenue,null);
  assert.equal((await observedMetrics(db,'two',other,from,until)).estimate,null);
  await configureEstimate(db,'one',20000,500,'USD');summary=await observedMetrics(db,'one',page,from,until);
  assert.equal(summary.assumptions.version,2);assert.equal(summary.estimate?.currency,'USD');
  assert.equal(summary.estimate?.amount_minor_numerator,'10000000');
  const installation=crypto.randomUUID();await db.query('UPDATE protected_pages SET installation_id=$1 WHERE id=$2',[installation,other]);
  await db.query("INSERT INTO protected_page_urls VALUES($1,'http://127.0.0.1:8080','/')",[other]);
  const handle=observedSessionGateway(db);const gateway=createServer((req,res)=>{if(!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(gateway,'listening');
  const ga=gateway.address();assert.ok(ga&&typeof ga!=='string');
  try{
   const post=(body:object)=>fetch(`http://127.0.0.1:${ga.port}/i/${installation}/observed-session`,{method:'POST',headers:{origin:'http://localhost:8080','content-type':'text/plain'},body:JSON.stringify(body)});
   const session={session:'b'.repeat(32),signals:{}};
   assert.equal((await post(session)).status,204);assert.equal((await post(session)).status,204);
   assert.equal((await post({...session,project:'one'})).status,400);
   const facts=await db.query("SELECT count(*)::int n FROM observed_action_facts WHERE project_id='two' AND session_id=$1",[session.session]);assert.equal(facts.rows[0].n,1);
   const decision=await issueObservedReceipt(db,'two',other,'http://localhost:8080','d'.repeat(32),'REFERRAL',{action:'REPLACE_CONVERSION',version:2,mappings:[{marker:'point001',surface:'main'}]});assert.ok(decision.observationReceipt);
   const action={receipt:decision.observationReceipt,event:crypto.randomUUID(),marker:'point001',surface:'main'};
   const postAction=(body:object)=>fetch(`http://127.0.0.1:${ga.port}/i/${installation}/observed-action`,{method:'POST',headers:{origin:'http://localhost:8080','content-type':'text/plain'},body:JSON.stringify(body)});
   assert.equal((await postAction({...action,marker:'wrong001'})).status,400);
   const attempts=await Promise.all(Array.from({length:5},()=>postAction(action)));assert.ok(attempts.every(r=>r.status===204));
   const clicked=await db.query("SELECT count(*)::int n FROM observed_action_facts WHERE project_id='two' AND action='CTA_CLICK_OBSERVED'");assert.equal(clicked.rows[0].n,1);
   const prepared=await observedMetrics(db,'two',other,from,until);assert.equal(prepared.prepared_decisions?.[0].decisions,1);assert.equal(prepared.recovered_revenue,null);
   const foreign=await issueObservedReceipt(db,'one',page,'http://localhost:8080','d'.repeat(32),'REFERRAL',{action:'PAGE_REDIRECT',version:2});assert.equal((await postAction({...action,receipt:foreign.observationReceipt,marker:null,surface:null})).status,400);
   await db.query("UPDATE observed_decision_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[decision.observationReceipt]);assert.equal((await postAction(action)).status,400);
   await db.query('UPDATE protected_pages SET enabled=false WHERE id=$1',[other]);assert.equal((await post({...session,session:'c'.repeat(32)})).status,404);
  }finally{await new Promise<void>(resolve=>gateway.close(()=>resolve()));}

  await db.query((await readFile('infra/017_notification_settings.sql','utf8')).replace(/^\uFEFF/,''));
  await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL); CREATE TABLE admin_totp_codes(factor_id text,digest text,valid_until bigint,PRIMARY KEY(factor_id,digest))');
  const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const server=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const browser=await chromium.launch();
  try{
   const panel=await browser.newPage();await panel.goto(`http://127.0.0.1:${address.port}/admin/ui/`);
   await panel.getByLabel('Senha administrativa').fill('password');await panel.locator('#login [name=code]').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await panel.getByRole('button',{name:'Entrar',exact:true}).click();
   const config=panel.locator('#estimate-config');await config.locator('[name=project]').fill('one');await config.locator('[name=ticket]').fill('30000');await config.locator('[name=rate]').fill('100');await config.locator('[name=currency]').fill('BRL');await config.getByRole('button').click();
   await panel.waitForFunction(()=>document.getElementById('observed-result')?.textContent?.includes('30000'));
   const query=panel.locator('#observed-query');for(const [key,value] of Object.entries({project:'one',page,from,until}))await query.locator(`[name=${key}]`).fill(value);await query.getByRole('button').click();
   await panel.waitForFunction(()=>document.getElementById('observed-result')?.textContent?.includes('ESTIMATE'));
   const displayed=JSON.parse((await panel.locator('#observed-result').textContent())!);assert.equal(displayed.estimate.amount_minor_numerator,'3000000');assert.equal(displayed.recovered_revenue,null);
  }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}

 }finally{await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
