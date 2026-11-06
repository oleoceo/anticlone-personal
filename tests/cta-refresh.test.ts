import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { Secret, TOTP } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';
import { saveDraft, activatePolicy } from '../apps/protection-policy.js';

const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
test('CTA refresh preserves independent mapping and expires locally', {timeout:90000}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='gs08_'+randomUUID().replaceAll('-','');
  const adminDb=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let fixture:ReturnType<typeof createServer>|undefined, admin:ReturnType<typeof createAdminServer>|undefined;
  let app:ReturnType<typeof spawn>|undefined, browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    for (const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','023_cta_commercial']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    assert.equal((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='cta_drift_alerts'::regclass AND tgname='prepare_cta_alert_delivery'")).rowCount,0);
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
    const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1'); await once(admin,'listening');
    const adminUrl=`http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    const login=await fetch(`${adminUrl}/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(secret)}).generate()})});
    assert.equal(login.status,200); const {token}=await login.json() as {token:string};
    const html='<button id="ordinary">Open</button><input id="field"><a data-anticlone-point="basic001" href="/native-basic">Basic</a><a data-anticlone-point="premium1" href="/native-premium">Premium</a><script src="http://127.0.0.1:3000/runtime.js"></script>';
    fixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url==='/clone'?html:'<h1>destination</h1>')).listen(0,'127.0.0.1'); await once(fixture,'listening');
    const port=(fixture.address() as AddressInfo).port, original=`http://127.0.0.1:${port}`, clone=`http://localhost:${port}`, project='gs08_'+randomUUID();
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    const post=(part:string,body:object,authenticated=true)=>fetch(`${adminUrl}/admin/projects/${project}/cta/${part}`,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    const candidates=['basic001','premium1'].map((marker,i)=>({marker,kind:'a',parent:'body',ordinal:i+1,url:clone+'/native-'+(i?'premium':'basic'),commercial:{amount:i?9700:6700,currency:'BRL'}}));
    const inventory=async (rows:typeof candidates)=>{assert.equal((await post('inventory',{surface:'landing',candidates:rows})).status,200);};
    await inventory(candidates);
    const points=(await db.query('SELECT id,marker FROM cta_points WHERE project_id=$1',[project])).rows;
    const destinations:Record<string,string>={};
    for (const [marker,offer] of [['basic001','basic'],['premium1','premium']] as const) {
      const response=await post('destinations',{offer,url:original+'/official-'+offer}); assert.equal(response.status,200);
      const {id}=await response.json() as {id:string}; destinations[marker]=id;
      assert.equal((await post('mappings',{pointId:points.find(x=>x.marker===marker).id,offer,destinationId:id})).status,200);
    }
    assert.equal((await post('policy',{enabled:true,surface:'landing',pathname:'/clone',allocation})).status,200);
    app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
    let ready=false; for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));} assert.ok(ready);
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    const page=await browser.newPage();
    await page.clock.install();
    await page.addInitScript(()=>{
      const add=document.addEventListener.bind(document);
      document.addEventListener=((type:string, listener:EventListenerOrEventListenerObject, options?:boolean|AddEventListenerOptions)=>{
        add(type,listener,options); if(type==='click') document.documentElement.dataset.cta='ready';
      }) as typeof document.addEventListener;
    });
    let requests=0; page.on('request',r=>{if(['fetch','xhr'].includes(r.resourceType())) requests++;});
    const initial=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(clone+'/clone'); const staleBody=await (await initial).json();
    await page.waitForFunction(()=>document.documentElement.dataset.cta==='ready');
    const click=async (marker:string, expected:string)=>{
      const before=requests;
      const target=await page.evaluate((id)=>{
        const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="'+id+'"]')!;
        let observed=''; const capture=(event:Event)=>{observed=node.href;event.preventDefault();};
        window.addEventListener('click',capture,{once:true}); node.click(); return observed;
      },marker);
      assert.equal(target,expected); assert.equal(requests,before,'no network in click');
      await page.clock.runFor(1);
    };
    const navigate=async (marker:string, expected:string)=>{
      const anchor=page.locator(`[data-anticlone-point="${marker}"]`);
      await anchor.evaluate(node=>node.setAttribute('target','_blank'));
      const before=requests, popup=page.waitForEvent('popup');
      await anchor.click(); const opened=await popup;
      await opened.waitForURL(expected); assert.equal(requests,before,'no network in click');
      await opened.close(); await anchor.evaluate(node=>node.removeAttribute('target')); await page.clock.runFor(1);
    };
    await click('basic001',original+'/official-basic');
    await click('premium1',original+'/official-premium');
    // Regression: an eligible entry policy must not suppress the interaction phase.
    await saveDraft(db,project,{enabled:true,approved_destination:original+'/entry',stealth:true,allocation});
    await activatePolicy(db,project);
    const phaseResponse=await fetch('http://127.0.0.1:3000/cta-refresh',{method:'POST',headers:{origin:clone,'content-type':'text/plain'},body:JSON.stringify({session:'0123456789abcdef0123456789abcdef',signals:{}})});
    assert.equal((await phaseResponse.json() as {action:string}).action,'REPLACE_CONVERSION');
    for (const cancel of ['interaction','expiry'] as const) {
      const phased=await browser.newPage(); await phased.clock.install();
      let releaseEntry!:()=>void, entryReady!:()=>void;
      const heldEntry=new Promise<void>(resolve=>{releaseEntry=resolve;});
      const readyEntry=new Promise<void>(resolve=>{entryReady=resolve;});
      await phased.route('**/entry-decision',async route=>{
        const response=await route.fetch();
        assert.equal((await response.json() as {action:string}).action,'PAGE_REDIRECT');
        entryReady(); await heldEntry; await route.fulfill({response});
      });
      await phased.goto(clone+'/clone'); await readyEntry;
      if (cancel==='interaction') await phased.evaluate(()=>dispatchEvent(new PointerEvent('pointerdown')));
      else await phased.clock.fastForward(151);
      const interactionResponse=phased.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
      releaseEntry(); assert.equal((await (await interactionResponse).json()).action,'REPLACE_CONVERSION');
      await phased.clock.runFor(1);
      const target=await phased.evaluate(()=>{
        const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="premium1"]')!;
        let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
      });
      assert.equal(target,original+'/official-premium',cancel);
      assert.equal(phased.url(),clone+'/clone'); await phased.close();
    }
    await saveDraft(db,project,{enabled:false,approved_destination:original+'/entry',stealth:true,allocation});
    await activatePolicy(db,project);
    await navigate('basic001',original+'/official-basic');
    await navigate('premium1',original+'/official-premium');
    const commercialApproval=async(marker:string,version:number)=>{
      const result=await db.query(`SELECT o.id,o.capture_id,o.commercial_amount,o.commercial_currency,p.id AS point_id FROM cta_observations o JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id JOIN cta_captures c ON c.id=o.capture_id WHERE p.project_id=$1 AND p.marker=$2 AND c.is_current`,[project,marker]);
      const x=result.rows[0]; return {surface:'landing',captureId:x.capture_id,pointId:x.point_id,observationId:x.id,destinationId:destinations[marker],amount:Number(x.commercial_amount),currency:x.commercial_currency,version};
    };
    assert.equal((await post('commercial',await commercialApproval('basic001',0),false)).status,401);
    assert.equal((await post('commercial',{...await commercialApproval('basic001',0),project:'outro'})).status,400);
    assert.equal((await post('commercial',await commercialApproval('basic001',0))).status,200);
    assert.equal((await post('commercial',await commercialApproval('premium1',0))).status,200);
    assert.equal((await post('inventory',{surface:'landing',candidates:[{...candidates[0],commercial:{amount:8900,currency:null}},candidates[1]]})).status,200);
    assert.equal((await db.query("SELECT suspension FROM cta_commercial_references r JOIN cta_points p ON p.project_id=r.project_id AND p.id=r.point_id WHERE p.project_id=$1 AND p.marker='basic001'",[project])).rows[0].suspension,'UNCERTAIN');
    await inventory(candidates);
    assert.equal((await post('commercial',await commercialApproval('basic001',1))).status,200);
    candidates[0].commercial.amount=8900;
    await inventory(candidates); await inventory(candidates);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM cta_drift_alerts WHERE project_id=$1 AND reason='COMMERCIAL_CHANGED'",[project])).rows[0].n,1);
    const commercialRefresh=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await commercialRefresh; await page.clock.runFor(1);
    await click('basic001',clone+'/native-basic'); await click('premium1',original+'/official-premium');
    assert.equal((await post('commercial',await commercialApproval('basic001',2))).status,200);
    const commercialRestored=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await commercialRestored; await page.clock.runFor(1);
    await click('basic001',original+'/official-basic'); await click('premium1',original+'/official-premium');
    const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await mobile.clock.install();
    await mobile.addInitScript(()=>{
      let count=0; const add=document.addEventListener.bind(document);
      document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
        add(type,listener,options); if(type==='click') document.documentElement.dataset.listeners=String(++count);
      }) as typeof document.addEventListener;
    });
    const mobileEntry=mobile.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await mobile.goto(clone+'/clone'); await mobileEntry;
    await mobile.waitForFunction(()=>document.documentElement.dataset.listeners==='1');
    await mobile.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    await mobile.clock.fastForward(3*60*60*1000);
    await inventory([{...candidates[0],url:clone+'/changed'},candidates[1]]);
    assert.equal((await db.query('SELECT review_required FROM cta_points WHERE project_id=$1 AND marker=$2',[project,'basic001'])).rows[0].review_required,true);
    let releaseMobile!:()=>void; const mobileHold=new Promise<void>(resolve=>{releaseMobile=resolve;});
    let mobileRequested!:()=>void; const mobileRequest=new Promise<void>(resolve=>{mobileRequested=resolve;});
    await mobile.route('**/cta-refresh',async route=>{const response=await route.fetch(); mobileRequested(); await mobileHold; await route.fulfill({response});});
    await mobile.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));});
    await mobileRequest;
    const mobileClick=async (marker:string)=>mobile.evaluate(id=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="'+id+'"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    },marker);
    await t.test('pending mobile refresh keeps the native click without waiting',async()=>{
      assert.equal(await mobileClick('premium1'),clone+'/native-premium');
    });
    await mobile.clock.runFor(1);
    const mobileResponse=mobile.waitForResponse(r=>r.url().endsWith('/cta-refresh')); releaseMobile(); await mobileResponse; await mobile.clock.runFor(1);
    assert.equal(await mobileClick('basic001'),clone+'/native-basic'); await mobile.clock.runFor(1);
    assert.equal(await mobileClick('premium1'),original+'/official-premium'); await mobile.clock.runFor(1);
    let mobileFetches=0; mobile.on('request',request=>{if(['fetch','xhr'].includes(request.resourceType())) mobileFetches++;});
    const mobileAnchor=mobile.locator('[data-anticlone-point="premium1"]');
    await mobileAnchor.evaluate(node=>node.setAttribute('target','_blank'));
    const beforeTap=mobileFetches, mobilePopup=mobile.waitForEvent('popup');
    await mobileAnchor.tap(); const checkout=await mobilePopup; await checkout.waitForURL(original+'/official-premium');
    assert.equal(mobileFetches,beforeTap); await checkout.close();
    assert.equal(await mobile.evaluate(()=>document.documentElement.dataset.listeners),'1');
    await mobile.unroute('**/cta-refresh');
    let firstHeld!:()=>void, firstRelease!:()=>void, calls=0;
    const heldRequest=new Promise<void>(resolve=>{firstHeld=resolve;}), releaseRequest=new Promise<void>(resolve=>{firstRelease=resolve;});
    await mobile.route('**/cta-refresh',async route=>{if (++calls===1) {firstHeld(); await releaseRequest; await route.abort().catch(()=>{});} else await route.continue();});
    await mobile.clock.fastForward(60000); await heldRequest;
    await mobile.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
    const retry=mobile.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await mobile.clock.fastForward(5000); await retry; firstRelease(); await mobile.clock.runFor(1);
    assert.equal(calls,2); assert.equal(await mobileClick('basic001'),clone+'/native-basic'); await mobile.clock.runFor(1);
    assert.equal(await mobileClick('premium1'),original+'/official-premium'); await mobile.clock.runFor(1);
    await mobile.unroute('**/cta-refresh');
    await mobile.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    await mobile.clock.fastForward(120000);
    await mobile.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    const restored=mobile.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await mobile.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false}); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
    await restored; await mobile.clock.runFor(1);
    assert.equal(await mobileClick('basic001'),clone+'/native-basic'); await mobile.clock.runFor(1);
    assert.equal(await mobileClick('premium1'),original+'/official-premium');
    assert.equal(await mobile.evaluate(()=>document.documentElement.dataset.listeners),'1');
    await mobile.close();
    const delayedCore=await browser.newPage();
    let coreSeen!:()=>void, coreRelease!:()=>void;
    const coreRequested=new Promise<void>(resolve=>{coreSeen=resolve;}), coreHold=new Promise<void>(resolve=>{coreRelease=resolve;});
    await delayedCore.addInitScript(()=>document.addEventListener('load',event=>{if(event.target instanceof HTMLScriptElement && event.target.src.endsWith('/core.js')) document.documentElement.dataset.core='loaded';},true));
    await delayedCore.route('**/core.js',async route=>{coreSeen(); await coreHold; await route.continue();});
    await delayedCore.goto(clone+'/clone',{waitUntil:'domcontentloaded'}); await coreRequested;
    await delayedCore.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    coreRelease(); await delayedCore.waitForFunction(()=>document.documentElement.dataset.core==='loaded');
    const resumedEntry=delayedCore.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await delayedCore.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    assert.equal((await (await resumedEntry).json()).action,'REPLACE_CONVERSION');
    await delayedCore.close();
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await refreshed;
    await page.clock.runFor(1);
    await click('basic001',clone+'/native-basic');
    await click('premium1',original+'/official-premium');
    await navigate('basic001',clone+'/native-basic');
    await navigate('premium1',original+'/official-premium');
    assert.equal((await post('policy',{enabled:true,surface:'landing',pathname:'/clone',allocation:{PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0}})).status,200);
    const excluded=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await excluded; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    assert.equal((await post('policy',{enabled:false,surface:'landing',pathname:'/clone',allocation})).status,200);
    const disabled=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); assert.equal((await (await disabled).json()).ctaVersion,3);
    await click('premium1',clone+'/native-premium');
    await page.route('**/cta-refresh',route=>route.fulfill({json:staleBody}));
    const afterDisabled=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await afterDisabled; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    await page.unroute('**/cta-refresh');
    assert.equal((await post('policy',{enabled:true,surface:'landing',pathname:'/clone',allocation})).status,200);
    const enabled=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await enabled; await page.clock.runFor(1);
    await click('premium1',original+'/official-premium');
    await page.route('**/cta-refresh',route=>route.fulfill({json:staleBody}));
    const olderVersion=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await olderVersion; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    await page.unroute('**/cta-refresh');
    const restart=async (risk:string)=>{
      app!.kill('SIGTERM'); await once(app!,'exit');
      app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:risk},stdio:['ignore','ignore','inherit']});
      let online=false; for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){online=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));} assert.ok(online);
    };
    await restart('');
    const uncertain=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await uncertain; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    await restart('LOW');
    const low=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await low; await page.clock.runFor(1);
    await click('premium1',original+'/official-premium');
    for (const risk of ['HIGH','ERROR']) {
      await restart(risk);
      for (const phase of ['entry-decision','cta-refresh']) {
        const response=await fetch('http://127.0.0.1:3000/'+phase,{method:'POST',headers:{origin:clone,'content-type':'text/plain'},body:JSON.stringify({session:'0123456789abcdef0123456789abcdef',signals:{medium:'cpc'}})});
        assert.equal((await response.json() as {action:string}).action,'OBSERVE_ONLY',`${risk} ${phase} paid`);
      }
      const denied=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
      await page.clock.fastForward(60000); await denied; await page.clock.runFor(1);
      await click('premium1',clone+'/native-premium');
    }
    await restart('LOW');
    await page.route('**/cta-refresh',route=>route.fulfill({status:200,body:'invalid json'}));
    const invalid=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await invalid; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    await page.unroute('**/cta-refresh');
    const renewed=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(120000); await renewed; await page.clock.runFor(1);
    await click('premium1',original+'/official-premium');
    await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    await page.clock.fastForward(120000);
    await click('premium1',clone+'/native-premium');
    const returned=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));});
    await returned; await page.clock.runFor(1);
    await click('premium1',original+'/official-premium');
    await page.route('**/cta-refresh',route=>route.abort());
    const failed=page.waitForEvent('requestfailed',r=>r.url().endsWith('/cta-refresh'));
    await page.clock.fastForward(60000); await failed; await page.clock.runFor(1);
    await click('premium1',clone+'/native-premium');
    await page.unroute('**/cta-refresh');
    const noRedirect=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await page.route('**/cta-refresh',route=>route.fulfill({json:{action:'PAGE_REDIRECT',version:1,destination:original+'/late'}}));
    await page.clock.fastForward(120000); await noRedirect; await page.clock.runFor(1);
    assert.equal(page.url(),clone+'/clone');
    await click('premium1',clone+'/native-premium');
    await page.unroute('**/cta-refresh');
    await page.evaluate(()=>history.pushState({},'', '/another'));
    await page.evaluate(()=>history.pushState({},'', '/clone'));
    await click('premium1',clone+'/native-premium');
    const delayed=await browser.newPage(); await delayed.clock.install();
    let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
    let intercepted!:()=>void; const interceptedEntry=new Promise<void>(resolve=>{intercepted=resolve;});
    await delayed.route('**/entry-decision',async route=>{intercepted(); await held; await route.fulfill({json:staleBody});});
    await delayed.goto(clone+'/clone'); await interceptedEntry;
    const newer=delayed.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
    await delayed.clock.fastForward(60000); await newer; await delayed.clock.runFor(1);
    const oldResponse=delayed.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    release(); await oldResponse; await delayed.clock.runFor(1);
    const observed=await delayed.evaluate(()=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="basic001"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    });
    assert.equal(observed,clone+'/native-basic','late initial response must not restore suspended mapping');
    await delayed.clock.runFor(1);
    const independent=await delayed.evaluate(()=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="premium1"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    });
    assert.equal(independent,original+'/official-premium');
    await delayed.clock.runFor(1);
    await delayed.evaluate(()=>{history.pushState({},'', '/other'); history.pushState({},'', '/clone');});
    const afterRoute=await delayed.evaluate(()=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="premium1"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    });
    assert.equal(afterRoute,clone+'/native-premium');
    await delayed.close();
    // The response was computed before revocation but is delivered afterwards.
    const revoked=await browser.newPage();
    let releaseRevoked!:()=>void, responseComputed!:()=>void;
    const holdRevoked=new Promise<void>(resolve=>{releaseRevoked=resolve;});
    const computed=new Promise<void>(resolve=>{responseComputed=resolve;});
    await revoked.route('**/entry-decision',async route=>{
      const response=await route.fetch();
      assert.equal((await response.json() as {action:string}).action,'REPLACE_CONVERSION');
      responseComputed(); await holdRevoked; await route.fulfill({response});
    });
    await revoked.goto(clone+'/clone'); await computed;
    assert.equal((await post('policy',{enabled:false,surface:'landing',pathname:'/clone',allocation})).status,200);
    const delivered=revoked.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    releaseRevoked(); await delivered;
    await revoked.waitForTimeout(100);
    const revokedTarget=await revoked.evaluate(()=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="premium1"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    });
    assert.equal(revokedTarget,original+'/official-premium','a recent response may be accepted before the client learns of revocation');
    await revoked.close();
    assert.equal((await post('policy',{enabled:true,surface:'landing',pathname:'/clone',allocation})).status,200);
    const late=await browser.newPage(); await late.clock.install();
    await late.route('**/entry-decision',async route=>{
      const response=await route.fetch();
      assert.equal((await response.json() as {action:string}).action,'REPLACE_CONVERSION');
      await late.clock.fastForward(5001); await route.fulfill({response});
    });
    const lateResponse=late.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await late.goto(clone+'/clone'); await lateResponse; await late.clock.runFor(1);
    const lateTarget=await late.evaluate(()=>{
      const node=document.querySelector<HTMLAnchorElement>('[data-anticlone-point="premium1"]')!;
      let href=''; window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true}); node.click(); return href;
    });
    assert.equal(lateTarget,clone+'/native-premium','CTA response over five seconds old is rejected');
    await late.close();
  } finally {
    if (browser) await browser.close();
    if (app && app.exitCode===null && app.signalCode===null) {app.kill('SIGTERM'); await once(app,'exit');}
    if (fixture?.listening) await new Promise<void>(r=>fixture!.close(()=>r()));
    if (admin?.listening) await new Promise<void>(r=>admin!.close(()=>r()));
    await db.end(); await adminDb.query(`DROP SCHEMA ${schema} CASCADE`); await adminDb.end();
  }
});
