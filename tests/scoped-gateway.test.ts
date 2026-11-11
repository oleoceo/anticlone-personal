import {distributionAdmin, type Distribution} from '../apps/runtime-distribution.js';
import {importInventory,reviewPoint} from '../apps/cta-inventory.js';
import {SMTPServer} from 'smtp-server';
import {deliverOne} from '../apps/alerts.js';
import {configureEstimate,observedMetrics} from '../apps/observed-metrics.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium, type Page, type Response } from 'playwright';
import { managePages, PageConflict } from '../apps/protected-pages.js';
import { createAdminServer } from '../apps/admin-auth.js';
import { publishCtaPolicy } from '../apps/cta-policy.js';
import { TOTP, Secret } from 'otpauth';
import { investigation } from '../apps/investigation.js';

for (const distributionMode of [false,true]) test('scoped browser observations isolate projects on one origin and preserve copied installation; distribution='+distributionMode, {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='scoped_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const health=randomUUID(), finance=randomUUID(), entryOne=randomUUID(), entryTwo=randomUUID();
  const pageOne=randomUUID(), pageTwo=randomUUID();
  const distributions=new Map<string,Distribution>();
  const scriptBase=(id:string)=>distributions.get(id)?.bases.SCRIPT ?? 'http://127.0.0.1:3000/i/'+id+'/';
  const telemetryBase=(id:string)=>distributions.get(id)?.bases.TELEMETRY ?? 'http://127.0.0.1:3000/i/'+id+'/';
  const fixture=createServer((req,res) => {
    const path=req.url?.split('?')[0];
    if(path==='/shared-checkout'){res.writeHead(200,{'content-type':'text/html'}).end('<h1>Checkout destination</h1>');return;}
    const id=path==='/entry-one' ? entryOne : path==='/entry-two' ? entryTwo : path==='/financas' ? finance : health;
    res.writeHead(200,{'content-type':'text/html'}).end(`<div data-anticlone-surface="main"><a data-anticlone-point="shared01" href="/checkout">Checkout</a><a data-anticlone-point="second01" href="/checkout-two">Second offer</a><a data-anticlone-point="whats001" href="/wa-synthetic">Synthetic WhatsApp</a></div><script src="${scriptBase(id)}runtime.js"></script><script src="${scriptBase(id)}fallback.js"></script>`);
  }).listen(0,'127.0.0.1');
  await once(fixture,'listening');
  const address=fixture.address(); assert.ok(address && typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  const messages:string[]=[];
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){let message='';stream.on('data',chunk=>{message+=String(chunk);});stream.on('end',()=>{messages.push(message);callback();});}});
  await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));const smtpAddress=smtp.server.address();assert.ok(smtpAddress&&typeof smtpAddress!=='string');
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let admin: ReturnType<typeof createAdminServer> | undefined;
  try {
    for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','023_cta_commercial','018_notification_budget','019_alert_outbox_expiry','025_installation_signals','036_cta_surface_policies']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query(await readFile('infra/037_protected_pages.sql','utf8'));
    await db.query(await readFile('infra/038_page_url_review.sql','utf8'));
    await db.query(await readFile('infra/039_page_policy_bindings.sql','utf8'));
    await db.query(await readFile('infra/040_page_policy_approvals.sql','utf8'));
    await db.query(await readFile('infra/041_page_entry_activation.sql','utf8'));
    await db.query(await readFile('infra/042_page_installation_signals.sql','utf8'));
    await db.query(await readFile('infra/047_observed_metrics.sql','utf8'));
    await db.query(await readFile('infra/048_observed_receipts.sql','utf8'));
    await db.query(await readFile('infra/033_clone_delivery_attempts.sql','utf8'));
    await db.query(await readFile('infra/049_isolated_runtime_drift.sql','utf8'));
    await db.query(await readFile('infra/051_runtime_distribution.sql','utf8'));
    await db.query((await readFile('infra/017_notification_settings.sql','utf8')).replace(/^\uFEFF/,''));
    for(const file of ['030_infrastructure_dns','031_investigation_timeline']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query(await readFile('infra/015_cta_alert_deliveries.sql','utf8'));
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    await db.query("INSERT INTO projects VALUES ('health','Health',$1),('finance','Finance',$1)",[origin]);
    const hp=randomUUID(), fp=randomUUID();
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES ($1,'health',$2,'Health'),($3,'finance',$4,'Finance')",[hp,health,fp,finance]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES ($1,$3,'/saude'),($2,$3,'/financas')",[hp,fp,origin]);
    const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
    for (const [project,path] of [['health','/saude'],['finance','/financas']]) {
      const point=randomUUID(), destination=randomUUID();
      await db.query('INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES($1,1,true,$2,$3,$4)',[project,'main',path,allocation]);
      await db.query("INSERT INTO active_cta_surface_policies VALUES($1,'main',1)",[project]);
      await db.query("INSERT INTO page_cta_policy_bindings(project_id,page_id,surface,version) VALUES($1,$2,'main',1)",[project,project==='health' ? hp : fp]);
      await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES($1,$2,'main','shared01','a','offer')",[project,point]);
      await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES($1,'offer',$2,$3)",[project,destination,origin+'/'+project+'-checkout'+(project==='health'?'?utm_source=offer':'')]);
      await db.query("INSERT INTO cta_mappings VALUES($1,$2,'offer',$3)",[project,point,destination]);
    }
    for(const [marker,offer,path] of [['second01','second','/official-second'],['whats001','whatsapp','/wa-approved']]){
      const point=randomUUID(),destination=randomUUID();await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('health',$1,'main',$2,'a',$3)",[point,marker,offer]);await db.query("INSERT INTO cta_destinations VALUES('health',$1,$2,$3)",[offer,destination,origin+path]);await db.query("INSERT INTO cta_mappings VALUES('health',$1,$2,$3)",[point,offer,destination]);
    }
    for(const [marker,path] of [['shared01','/checkout'],['second01','/checkout-two'],['whats001','/wa-synthetic']])await db.query("INSERT INTO cta_observations(project_id,point_id,evidence,confidence,observed_url) SELECT 'health',id,'controlled baseline','HIGH',$2 FROM cta_points WHERE project_id='health' AND marker=$1",[marker,`http://localhost:${address.port}`+path]);
    const shared=origin+'/shared-checkout?utm_source=offer';
    await db.query("INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation) VALUES('health',1,true,$1,true,$2)",[shared,allocation]);
    for (const [pageId,installation,path] of [[pageOne,entryOne,'/entry-one'],[pageTwo,entryTwo,'/entry-two']]) {
      await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'health',$2,$3)",[pageId,installation,path]);
      await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[pageId,origin,path]);
      const generation=await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[pageId]);
      await managePages(db,{action:'approve',project:'health',page:pageId,generation:generation.rows[0].url_generation,configGeneration:generation.rows[0].config_generation,entryVersion:1,ctaVersions:[]});
    }
    const state=await db.query('SELECT config_generation FROM protected_pages WHERE id=$1',[hp]);
    const request={action:'approve',project:'health',page:hp,generation:'1',configGeneration:state.rows[0].config_generation,entryVersion:null,ctaVersions:[1]};
    await assert.rejects(managePages(db,{...request,project:'finance'}),PageConflict);
    const concurrent=await Promise.allSettled([managePages(db,request),managePages(db,request)]);
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(concurrent.filter(result=>result.status==='rejected').length,1);
    const financeState=await db.query('SELECT config_generation FROM protected_pages WHERE id=$1',[fp]);
    await managePages(db,{action:'approve',project:'finance',page:fp,generation:'1',configGeneration:financeState.rows[0].config_generation,entryVersion:null,ctaVersions:[1]});
    const financeSnapshot=await db.query(`SELECT p.url_generation,p.config_generation,p.url_review_required,b.surface,b.version,a.id AS approval FROM protected_pages p JOIN page_cta_policy_bindings b ON b.page_id=p.id AND b.project_id=p.project_id JOIN page_policy_approvals a ON a.page_id=p.id AND a.project_id=p.project_id WHERE p.id=$1`,[fp]);
    if(distributionMode) for(const [project,pageId] of [['health',hp],['finance',fp],['health',pageOne],['health',pageTwo]]) {
      const result=await distributionAdmin(db,{action:'publish',project,page:pageId},{RUNTIME_PUBLIC_ORIGIN:'http://127.0.0.1:3000'});
      assert.ok(result.distribution);distributions.set(result.distribution.installation,result.distribution);
    }
    const env: NodeJS.ProcessEnv={...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,SMTP_PORT:String(smtpAddress.port),PORT:'3000',SCOPED_LAB_INSTALLATIONS:[health,entryOne,entryTwo].join(','),ATTRIBUTION_ALLOWLIST:JSON.stringify({health:{[pageOne]:{[shared]:{utm_source:['ads'],utm_campaign:['one']}},[pageTwo]:{[shared]:{utm_source:['ads'],utm_campaign:['two']}},[hp]:{[origin+'/health-checkout?utm_source=offer']:{utm_source:['ads'],utm_campaign:['spring']}}},finance:{[fp]:{[origin+'/finance-checkout']:{utm_campaign:['finance']}}}}),SCOPED_LAB_ORIGIN:`http://localhost:${address.port}`};
    delete env.PROJECT_ID; delete env.ALLOWED_ORIGIN;
    child=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:'ignore'});
    for (let i=0;i<100;i++) { try { if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break; } catch { /* starting */ } await new Promise(r=>setTimeout(r,50)); }
    browser=await chromium.launch();
    const page=await browser.newPage();
    await page.addInitScript(()=>{const add=document.addEventListener.bind(document);document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{add(type,listener,options);if(type==='click')document.documentElement.dataset.ctaReady='yes';}) as typeof document.addEventListener;});
    for (const path of ['/saude','/financas']) {
      const sessionResponse=page.waitForResponse(r=>r.url().endsWith('/observed-session'));
      const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
      await page.goto(origin+path); assert.equal((await response).status(),204);assert.equal((await sessionResponse).status(),204);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0);
    const sessions=await db.query("SELECT project_id,page_id,action,evidence FROM observed_action_facts ORDER BY project_id");
    assert.deepEqual(sessions.rows,[{project_id:'finance',page_id:fp,action:'SESSION_OBSERVED',evidence:'BROWSER_UNVERIFIED'},{project_id:'health',page_id:hp,action:'SESSION_OBSERVED',evidence:'BROWSER_UNVERIFIED'}]);
    // Real scoped decisions and PostgreSQL approvals; virtual time only holds the entry deadline.
    for (const [path,label] of [['/entry-one','one'],['/entry-two','two']]) {
      const controlled:Page=await browser.newPage();
      await controlled.clock.install({time:0}); await controlled.clock.pauseAt(1000);
      await controlled.route('**/entry-decision',async route=>{const result=await route.fetch();const payload=await result.json() as {observationReceipt?:string};assert.ok(payload.observationReceipt,'eligible scoped decision carries an observation receipt');await route.fulfill({response:result});},{times:1});
      let response:Promise<Response>=controlled.waitForResponse(r=>r.url().endsWith('/entry-decision'));
      await controlled.goto(`http://localhost:${address.port}${path}?utm_source=ads&utm_campaign=${label}&token=private`);
      assert.equal((await response).status(),200);
      await controlled.waitForURL(shared+'&utm_campaign='+label);
      const observedPage=label==='one'?pageOne:pageTwo;let persisted=false;
      for(let i=0;i<100;i++){const facts=await db.query("SELECT count(*)::int n FROM observed_action_facts WHERE page_id=$1 AND action='PAGE_REDIRECT_ATTEMPT'",[observedPage]);if(facts.rows[0].n===1){persisted=true;break;}await new Promise(r=>setTimeout(r,50));}
      assert.ok(persisted,'browser redirect attempt persisted independently of navigation');
      response=controlled.waitForResponse(r=>r.url().endsWith('/entry-decision'));
      const other=label==='one'?'two':'one';
      await controlled.goto(`http://localhost:${address.port}${path}?utm_campaign=${other}`); await response;
      await controlled.waitForURL(shared);
      await controlled.close();
    }
    const ineligible=await fetch(`${telemetryBase(entryOne)}entry-decision`,{method:'POST',headers:{origin,'content-type':'text/plain'},body:JSON.stringify({pathname:'/entry-one',session:'a'.repeat(32),signals:{}})});
    assert.deepEqual(await ineligible.json(),{action:'OBSERVE_ONLY'});
    const trafficCases=[{}, {medium:'cpc'}, {referrerHost:'google.com'}, {referrerHost:'publisher.test'}];
    const entryRequest=async(id:string,signals:object,session:string)=>await(await fetch(`${telemetryBase(id)}entry-decision`,{method:'POST',headers:{origin:`http://localhost:${address.port}`,'content-type':'text/plain'},body:JSON.stringify({pathname:id===entryOne?'/entry-one':'/entry-two',signals,session})})).json() as {action:string;version?:number;observationReceipt?:string};
    for(const signals of trafficCases)assert.equal((await entryRequest(entryTwo,signals,'b'.repeat(32))).action,'PAGE_REDIRECT');
    for(const [version,percentage] of [[2,0],[3,50]]){
      const configured={PAID_ATTRIBUTED:percentage,ORGANIC:percentage,REFERRAL:percentage,DIRECT_UNKNOWN:percentage};
      await db.query("INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation) VALUES('health',$1,true,$2,true,$3)",[version,shared,configured]);
      const generation=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[pageOne])).rows[0];
      await managePages(db,{action:'approve',project:'health',page:pageOne,generation:generation.url_generation,configGeneration:generation.config_generation,entryVersion:version,ctaVersions:[]});
      for(const signals of trafficCases){let selected=0;for(let index=0;index<20;index++){
        const session=index.toString(16).padStart(32,'0'),first=await entryRequest(entryOne,signals,session),second=await entryRequest(entryOne,signals,session);assert.equal(second.action,first.action);
        if(first.action==='PAGE_REDIRECT'){selected++;assert.equal(first.version,version);}else{assert.equal(first.action,'OBSERVE_ONLY');assert.equal(first.observationReceipt,undefined);}
      }if(percentage===0)assert.equal(selected,0);else assert.ok(selected>0&&selected<20);}
      assert.equal((await entryRequest(entryTwo,{},'b'.repeat(32))).version,1);
    }
    assert.deepEqual((await db.query("SELECT allocation FROM protection_policy_versions WHERE project_id='health' AND version=1")).rows[0].allocation,allocation);


    const response=page.waitForResponse(r=>r.url().includes('/observe/fallback'));
    const browserDecision=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(`http://localhost:${address.port}/outro-slug`); assert.equal((await response).status(),204); await browserDecision;
    await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    const clicked=await page.evaluate(()=>{const link=document.querySelector<HTMLAnchorElement>('a')!;let target='';window.addEventListener('click',event=>{target=link.href;event.preventDefault();},{once:true});link.click();return target;});
    assert.equal(clicked,origin+'/health-checkout?utm_source=offer');
    const attributedResponse=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(`http://localhost:${address.port}/outro-slug?utm_source=ads&utm_campaign=spring&token=private`); await attributedResponse;
    await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    const attributed=await page.evaluate(()=>{const link=document.querySelector<HTMLAnchorElement>('a')!;let target='';window.addEventListener('click',event=>{target=link.href;event.preventDefault();},{once:true});link.click();return target;});
    assert.equal(attributed,origin+'/health-checkout?utm_source=offer&utm_campaign=spring');
    const incidents=await db.query('SELECT project_id,host FROM incidents ORDER BY project_id');
    assert.deepEqual(incidents.rows,[{project_id:'health',host:'localhost'}]);
    await deliverOne(db,'health',smtpAddress.port);
    let accepted=false;for(let i=0;i<100;i++){const sent=await db.query("SELECT count(*)::int n FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='health' AND a.sent_at IS NOT NULL");if(sent.rows[0].n===1){accepted=true;break;}await new Promise(r=>setTimeout(r,50));}
    assert.ok(accepted);assert.equal(messages.length,1);await deliverOne(db,'health',smtpAddress.port);assert.equal(messages.length,1);
    const initialCase=(await investigation(db,'health'))[0];
    assert.equal(initialCase.host,'localhost');
    assert.ok(initialCase.history.first_direct_unknown_at);
    assert.deepEqual(initialCase.history.sources,['core','fallback']);
    assert.equal(initialCase.notification.history.length,1);
    assert.equal((await investigation(db,'finance')).length,0);
    // Controlled resolver records, not a DNS lookup or a claim about real hosting.
    await db.query(`INSERT INTO infrastructure_dns_observations(incident_id,project_id,host,record_type,result,source,state,valid_until,limitations,observed_at)
      SELECT id,project_id,host,'A',v.result::jsonb,'controlled-lab','OK',now(),'Simulated resolver; no network lookup',v.at FROM incidents CROSS JOIN
      (VALUES ('["8.8.8.8"]',now()-interval '2 minutes'),('["1.1.1.1"]',now()-interval '1 minute')) v(result,at) WHERE project_id='health'`);
    assert.ok((await investigation(db,'health'))[0].history.chronology.some((e: {source:string;description:string})=>e.source==='DNS'&&e.description.includes('mudança')));
    let clicks=0;for(let i=0;i<100;i++){clicks=(await db.query("SELECT count(*)::int n FROM observed_action_facts WHERE page_id=$1 AND action='CTA_CLICK_OBSERVED'",[hp])).rows[0].n;if(clicks===2)break;await new Promise(r=>setTimeout(r,50));}assert.equal(clicks,2);
    await configureEstimate(db,'health',10000,250,'BRL');
    const metrics=await observedMetrics(db,'health',hp,new Date(Date.now()-60000).toISOString(),new Date(Date.now()+60000).toISOString());assert.equal(metrics.estimate?.amount_minor_numerator,'5000000');assert.equal(metrics.recovered_revenue,null);assert.equal(metrics.external_load_confirmed,null);
    assert.equal((await observedMetrics(db,'finance',fp,new Date(Date.now()-60000).toISOString(),new Date(Date.now()+60000).toISOString())).estimate,null);
    const candidates=[['shared01','/changed-checkout'],['second01','/checkout-two'],['whats001','/wa-synthetic']].map(([marker,path],index)=>({marker,kind:'a',parent:'div',ordinal:index+1,url:`http://localhost:${address.port}`+path}));
    await importInventory(db,'health',{surface:'main',candidates});
    const driftDecision=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));await page.goto(`http://localhost:${address.port}/outro-slug`);await driftDecision;await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    const targets=await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).map(link=>{let target='';window.addEventListener('click',event=>{target=link.href;event.preventDefault();},{once:true});link.click();return target;}));
    assert.deepEqual(targets,[`http://localhost:${address.port}/checkout`,origin+'/official-second',origin+'/wa-approved']);
    assert.equal((await db.query("SELECT count(*)::int n FROM cta_drift_alerts WHERE project_id='health'")).rows[0].n,1);
    const driftChanged=(await db.query("SELECT p.id,m.destination_id,(SELECT id::text FROM cta_observations o WHERE o.project_id=p.project_id AND o.point_id=p.id ORDER BY id DESC LIMIT 1) observation FROM cta_points p JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id WHERE p.project_id='health' AND p.marker='shared01'")).rows[0];
    await reviewPoint(db,'health',{pointId:driftChanged.id,destinationId:driftChanged.destination_id,observationId:driftChanged.observation});
    assert.equal((await entryRequest(entryTwo,{},'b'.repeat(32))).version,1);


    const decide=(id:string,source:string) => fetch(`${telemetryBase(id)}entry-decision`,{method:'POST',headers:{origin:source,'content-type':'text/plain'},body:JSON.stringify({pathname:'/outro-slug',session:'a'.repeat(32),signals:{}})});
    const decision=await decide(health,`http://localhost:${address.port}`);
    const selected=await decision.json() as {action:string;pathname:string;mappings:{marker:string;destination:string}[]};
    assert.equal(selected.action,'REPLACE_CONVERSION'); assert.equal(selected.pathname,'/outro-slug');
    assert.equal(selected.mappings.find(row=>row.marker==='shared01')?.destination,origin+'/health-checkout?utm_source=offer');
    assert.deepEqual((selected as typeof selected & {attribution:unknown}).attribution,{[origin+'/health-checkout?utm_source=offer']:{utm_source:['ads'],utm_campaign:['spring']}});
    assert.deepEqual(await (await decide(finance,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    assert.deepEqual(await (await decide(finance,origin)).json(),{action:'OBSERVE_ONLY'});
    assert.deepEqual(await (await decide(health,origin)).json(),{action:'OBSERVE_ONLY'});
    await db.query("DELETE FROM page_cta_policy_bindings WHERE project_id='health'");
    assert.deepEqual(await (await decide(health,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    await db.query("INSERT INTO page_cta_policy_bindings VALUES('health',$1,'main',1)",[hp]);
    assert.equal((await (await decide(health,`http://localhost:${address.port}`)).json() as {action:string}).action,'OBSERVE_ONLY');
    const generation=await db.query('SELECT url_generation FROM protected_pages WHERE id=$1',[hp]);
    await managePages(db,{action:'add-url',project:'health',page:hp,url:origin+'/saude-nova'});
    await managePages(db,{action:'remove-url',project:'health',page:hp,url:origin+'/saude'});
    const changed=await db.query('SELECT url_generation,url_review_required FROM protected_pages WHERE id=$1',[hp]);
    assert.equal(BigInt(changed.rows[0].url_generation),BigInt(generation.rows[0].url_generation)+2n); assert.equal(changed.rows[0].url_review_required,true);
    assert.deepEqual(await (await decide(health,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    await assert.rejects(managePages(db,{action:'approve',project:'health',page:hp,generation:generation.rows[0].url_generation,configGeneration:'0',entryVersion:null,ctaVersions:[1]}),PageConflict);
    await publishCtaPolicy(db,'health',{enabled:true,surface:'main',pathname:'/saude-nova',allocation});
    await db.query("INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES('finance',99,true,'other','/financas',$1)",[allocation]);
    const current=await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[hp]);
    const candidate={action:'approve',project:'health',page:hp,generation:current.rows[0].url_generation,configGeneration:current.rows[0].config_generation,entryVersion:null,ctaVersions:[99]};
    await assert.rejects(managePages(db,candidate),PageConflict);
    await db.query("UPDATE cta_destinations SET url='https://incompatible.invalid/' WHERE project_id='health'");
    const changedConfig=await db.query('SELECT config_generation FROM protected_pages WHERE id=$1',[hp]);
    await assert.rejects(managePages(db,{...candidate,configGeneration:changedConfig.rows[0].config_generation,ctaVersions:[2]}),PageConflict);
    await db.query("UPDATE cta_destinations SET url=$1 WHERE project_id='health'",[origin+'/health-checkout']);
    const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    admin=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');
    await once(admin,'listening'); const adminAddress=admin.address(); assert.ok(adminAddress && typeof adminAddress!=='string');
    const panel=await browser.newPage(); await panel.goto(`http://127.0.0.1:${adminAddress.port}/admin/ui/`);
    await panel.getByLabel('Senha administrativa').fill('password'); await panel.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate()); await panel.getByRole('button',{name:'Entrar',exact:true}).click();
    await panel.locator('#incident-query select option').first().waitFor({state:'attached'});
    await panel.locator('#incident-query select[name=project]').selectOption('health'); await panel.getByRole('button',{name:'Consultar incidentes',exact:true}).click();
    await panel.getByRole('list',{name:'Linha do tempo investigativa'}).waitFor();
    assert.match(await panel.locator('#incident-list').innerText(),/Coleta incompleta/);
    assert.match(await panel.locator('#incident-list').innerText(),/DIRECT_UNKNOWN/);
    assert.match(await panel.locator('#incident-list').innerText(),/mudança entre respostas comparáveis/);
    assert.equal(await panel.locator('#incident-list details[open]').count(),0);
    await panel.locator('#incident-query select[name=project]').selectOption('finance');
    assert.equal(await panel.locator('#incident-list h3').count(),0);
    await panel.getByRole('button',{name:'Consultar incidentes',exact:true}).click();
    await panel.getByText('Nenhum incidente observado.',{exact:true}).waitFor();
    const form=panel.locator('#pages-form'); await form.locator('[name=project]').fill('health'); await form.locator('[name=page]').fill(hp); await form.getByRole('button',{name:'Consultar políticas da página'}).click();
    await panel.locator('#page-approval input[type=checkbox]').check(); await panel.getByRole('button',{name:'Confirmar aprovação de políticas'}).click();
    await panel.getByText('Políticas aprovadas para a geração 3.').waitFor();
    assert.equal((await (await decide(health,`http://localhost:${address.port}`)).json() as {action:string}).action,'REPLACE_CONVERSION');
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/entry-decision')); await page.goto(`http://localhost:${address.port}/outro-slug`); await refreshed;
    await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    const resumed=await page.evaluate(()=>{const link=document.querySelector<HTMLAnchorElement>('a')!;let target='';window.addEventListener('click',event=>{target=link.href;event.preventDefault();},{once:true});link.click();return target;});
    assert.equal(resumed,origin+'/health-checkout');
    await managePages(db,{action:'add-url',project:'health',page:hp,url:origin+'/outra'});
    assert.deepEqual(await (await decide(health,`http://localhost:${address.port}`)).json(),{action:'OBSERVE_ONLY'});
    const financeAfter=await db.query(`SELECT p.url_generation,p.config_generation,p.url_review_required,b.surface,b.version,a.id AS approval FROM protected_pages p JOIN page_cta_policy_bindings b ON b.page_id=p.id AND b.project_id=p.project_id JOIN page_policy_approvals a ON a.page_id=p.id AND a.project_id=p.project_id WHERE p.id=$1`,[fp]);
    assert.deepEqual(financeAfter.rows,financeSnapshot.rows);
    await assert.rejects(db.query("INSERT INTO page_cta_policy_bindings VALUES('finance',$1,'other',1)",[hp]),{code:'23503'});
    assert.equal((await fetch(`http://127.0.0.1:3000/i/${health}/observe`,{method:'POST',headers:{'content-type':'text/plain',origin},body:JSON.stringify({origin,pathname:'/saude',signals:{},project_id:'finance'})})).status,400);
    const withoutCore=await browser.newPage();await withoutCore.route('**/core.js',route=>route.abort());
    await withoutCore.goto(`http://localhost:${address.port}/outro-slug`);await withoutCore.getByText('Checkout',{exact:true}).click();await withoutCore.waitForURL(`http://localhost:${address.port}/checkout`);await withoutCore.close();
    const retained=(await db.query('SELECT count(*)::int n FROM observed_action_facts')).rows[0].n;
    child.kill('SIGTERM');await once(child,'exit');
    const offline=await browser.newPage();await offline.goto(`http://localhost:${address.port}/outro-slug`);await offline.getByText('Checkout',{exact:true}).click();await offline.waitForURL(`http://localhost:${address.port}/checkout`);await offline.close();
    assert.equal((await db.query('SELECT count(*)::int n FROM observed_action_facts')).rows[0].n,retained);
    child=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:'ignore'});
    let restarted=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3000/healthz')).ok){restarted=true;break;}}catch{/* startup */}await new Promise(r=>setTimeout(r,50));}assert.ok(restarted);
    assert.equal((await db.query('SELECT count(*)::int n FROM observed_action_facts')).rows[0].n,retained);
    assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE project_id='health'")).rows[0].n,1);assert.equal(messages.length,1);
    const persistedCase=(await investigation(db,'health'))[0];
    assert.deepEqual(persistedCase.first_observed_at,initialCase.first_observed_at);
    assert.equal(persistedCase.notification.history.length,1);
    assert.equal(persistedCase.infrastructure.dns.length,2);
    assert.equal((await investigation(db,'finance')).length,0);

  } finally {
    if (browser) await browser.close(); if (admin) await new Promise<void>(resolve=>admin!.close(()=>resolve()));
    if (child && child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await once(child,'exit'); }
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    fixture.close(); await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
