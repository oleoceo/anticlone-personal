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
import {approveCommercial} from '../apps/cta-inventory.js';
import { ctaDecision } from '../apps/cta-policy.js';

const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
test('Front3 integrated commercial: two prices, WhatsApp, popup/sticky/dynamic, stable identity and isolated drift', {timeout:90000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='multi_'+randomUUID().replaceAll('-','');
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}); await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`, db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let fixture:ReturnType<typeof createServer>|undefined, admin:ReturnType<typeof createAdminServer>|undefined;
  let app:ReturnType<typeof spawn>|undefined, browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','023_cta_commercial']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    const portFixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url?.startsWith('/clone') ? html : '<h1>native or official</h1>'));
    const html=`<section data-anticlone-surface="main"><a data-anticlone-point="classic01" data-anticlone-price-minor="6700" data-anticlone-currency="BRL" href="/native-classic">Buy</a><a data-anticlone-point="plus0001" data-anticlone-price-minor="9700" data-anticlone-currency="BRL" href="/native-plus">Buy</a><a data-anticlone-point="vip00001" href="/native-vip">Buy</a><a href="/unmarked">Buy ambiguous 12x/discount</a><a data-anticlone-point="contact1" href="https://whatsapp.fixture.test/send">WhatsApp synthetic</a></section><button id="open">Open modal</button><div id="dynamic"></div><script>
      addEventListener('load',()=>{ document.querySelector('#dynamic').innerHTML='<aside data-anticlone-surface="sticky"><a data-anticlone-point="classic01" href="/native-sticky">Buy</a></aside><aside data-anticlone-surface="popup"><a data-anticlone-point="popup001" href="/native-popup">Buy</a></aside><div role="dialog" hidden data-anticlone-surface="modal"><a data-anticlone-point="upsell01" href="/native-upsell">Buy</a></div><div data-anticlone-surface="dynamic"><a data-anticlone-point="dynamic1" href="/native-dynamic">Buy</a></div>'; });
      document.querySelector('#open').onclick=()=>document.querySelector('[data-anticlone-surface=modal]').hidden=false;</script><script src="http://127.0.0.1:3000/runtime.js"></script>`;
    fixture=portFixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
    const port=(fixture.address() as AddressInfo).port, original=`http://127.0.0.1:${port}`, clone=`http://localhost:${port}`, project='multi_'+randomUUID();
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    // Prove that the additive migration carries a pre-existing active policy forward.
    await db.query('INSERT INTO cta_policy_versions(project_id,version,enabled,surface,pathname,allocation) VALUES($1,1,true,$2,$3,$4)',[project,'main','/clone',allocation]);
    await db.query('INSERT INTO active_cta_policies VALUES($1,1)',[project]);
    await db.query(await readFile('infra/036_cta_surface_policies.sql','utf8'));
    assert.equal((await db.query('SELECT version FROM active_cta_surface_policies WHERE project_id=$1 AND surface=$2',[project,'main'])).rows[0].version,1);
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
    admin=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1'); await once(admin,'listening');
    const adminUrl=`http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    const login=await fetch(adminUrl+'/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(secret)}).generate()})});
    const {token}=await login.json() as {token:string};
    const post=(part:string,body:object)=>fetch(`${adminUrl}/admin/projects/${project}/cta/${part}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    const capture=await browser.newPage(); await capture.route('**/runtime.js',route=>route.abort()); await capture.goto(clone+'/clone'); await capture.locator('[data-anticlone-surface=sticky] a').waitFor();
    await capture.addScriptTag({content:await readFile('runtime/cta-inventory.js','utf8')});
    const surfaces=['main','sticky','popup','modal','dynamic'];
    for(const surface of surfaces) {
      const candidates=await capture.evaluate(s=>(window as unknown as {anticloneLabInventory:(surface:string)=>unknown[]}).anticloneLabInventory(s),surface);
      assert.equal((await post('inventory',{surface,candidates})).status,200);
      if(surface!=='main') assert.equal((await post('policy',{enabled:true,surface,pathname:'/clone',allocation})).status,200);
    }
    const points=(await db.query('SELECT id,marker,surface FROM cta_points WHERE project_id=$1 AND marker IS NOT NULL',[project])).rows;
    const cases=[['classic01','classic','main'],['plus0001','plus','main'],['vip00001','vip','main'],['contact1','contact','main'],['classic01','plus','sticky'],['popup001','special','popup'],['upsell01','upsell','modal'],['dynamic1','dynamic','dynamic']];
    const destinations=new Map<string,string>();
    for(const [marker,offer,surface] of cases) {
      if(!destinations.has(offer)) {const response=await post('destinations',{offer,url:original+'/official-'+offer}); assert.equal(response.status,200);destinations.set(offer,((await response.json()) as {id:string}).id);}
      assert.equal((await post('mappings',{pointId:points.find(p=>p.marker===marker && p.surface===surface).id,offer,destinationId:destinations.get(offer)})).status,200);
    }
    for(const marker of ['classic01','plus0001']){
      const row=(await db.query(`SELECT o.id,o.capture_id,o.point_id,o.commercial_amount,o.commercial_currency,m.destination_id FROM cta_observations o JOIN cta_points p ON p.id=o.point_id JOIN cta_captures c ON c.id=o.capture_id JOIN cta_mappings m ON m.point_id=p.id WHERE p.marker=$1 AND p.surface='main' AND c.is_current`,[marker])).rows[0];
      await approveCommercial(db,{project,surface:'main',pointId:row.point_id,captureId:row.capture_id,observationId:row.id,destinationId:row.destination_id,amount:Number(row.commercial_amount),currency:row.commercial_currency,version:0});
    }
    assert.deepEqual((await db.query('SELECT amount FROM cta_commercial_references ORDER BY amount')).rows.map(r=>r.amount),['6700','9700']);
    assert.ok((await db.query("SELECT 1 FROM cta_observations o JOIN cta_points p ON p.project_id=o.project_id AND p.id=o.point_id WHERE p.marker IS NULL AND o.commercial_amount IS NULL AND o.confidence='LOW' AND NOT EXISTS(SELECT 1 FROM cta_mappings m WHERE m.project_id=p.project_id AND m.point_id=p.id)")).rowCount,'unmarked commercial ambiguity remains unknown and unmapped');
    assert.equal((await post('policy',{enabled:true,surface:'other',pathname:'/clone2',allocation})).status,200);
    assert.equal((await post('policy',{enabled:true,surface:'main',pathname:'/clone2',allocation})).status,400);
    assert.equal((await post('inventory',{surface:'other',candidates:[{marker:'route001',kind:'a',parent:'div',ordinal:1,url:clone+'/native-route'}]})).status,200);
    const routePoint=(await db.query("SELECT id FROM cta_points WHERE project_id=$1 AND surface='other' AND marker='route001'",[project])).rows[0].id;
    const routeDestination=await post('destinations',{offer:'route',url:original+'/official-route'}); const routeId=((await routeDestination.json()) as {id:string}).id;
    assert.equal((await post('mappings',{pointId:routePoint,offer:'route',destinationId:routeId})).status,200);
    app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
    let ready=false;for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
    const page=await browser.newPage(); await page.clock.install();
    await page.addInitScript(()=>{const add=document.addEventListener.bind(document);document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{add(type,listener,options);if(type==='click')document.documentElement.dataset.ctaReady='yes';}) as typeof document.addEventListener;});
    const entry=page.waitForResponse(r=>r.url().endsWith('/entry-decision')); await page.goto(clone+'/clone');await entry;
    await page.waitForFunction(()=>document.documentElement.dataset.ctaReady==='yes');
    let requests=0;page.on('request',r=>{if(r.url().endsWith('/entry-decision')||r.url().endsWith('/cta-refresh')) requests++;});
    const click=async(marker:string,surface='main')=>page.evaluate(({id,scope})=>{const node=document.querySelector<HTMLAnchorElement>(`[data-anticlone-surface="${scope}"] [data-anticlone-point="${id}"]`)!;let result='';window.addEventListener('click',e=>{result=node.href;e.preventDefault();},{once:true});node.click();return result;},{id:marker,scope:surface});
    await page.locator('#open').click(); assert.equal(await page.locator('[role=dialog]').isVisible(),true);
    for(const [marker,offer,surface] of cases){const before=requests;assert.equal(await click(marker,surface),original+'/official-'+offer,marker);assert.equal(requests,before);await page.clock.runFor(1);}
    const unscoped=await page.evaluate(()=>{const root=document.querySelector('[data-anticlone-surface=main]')!;root.removeAttribute('data-anticlone-surface');const node=root.querySelector<HTMLAnchorElement>('[data-anticlone-point=classic01]')!;let href='';window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true});node.click();root.setAttribute('data-anticlone-surface','main');return href;});
    assert.equal(unscoped,clone+'/native-classic');await page.clock.runFor(1);
    const unmarked=await page.evaluate(()=>{const node=document.querySelector<HTMLAnchorElement>('a:not([data-anticlone-point])')!;let href='';window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true});node.click();return href;});
    assert.equal(unmarked,clone+'/unmarked');await page.clock.runFor(1);
    for(const risk of ['HIGH','UNCERTAIN']) assert.equal((await ctaDecision(db,project,original,clone,clone,risk,'0'.repeat(32),'DIRECT_UNKNOWN','/clone')).action,'OBSERVE_ONLY');
    assert.equal((await post('policy',{enabled:true,surface:'popup',pathname:'/clone',allocation:{...allocation,DIRECT_UNKNOWN:0}})).status,200);
    const divided=await ctaDecision(db,project,original,clone,clone,'LOW','0'.repeat(32),'DIRECT_UNKNOWN','/clone');
    assert.ok(divided.mappings?.some(row=>row.marker==='vip00001'));assert.ok(!divided.mappings?.some(row=>row.marker==='popup001'));
    assert.equal((await post('policy',{enabled:true,surface:'popup',pathname:'/clone',allocation})).status,200);
    for(const [marker,offer,surface] of cases){
      const node=page.locator(`[data-anticlone-surface="${surface}"] [data-anticlone-point="${marker}"]`);
      await node.evaluate(element=>element.setAttribute('target','_blank'));
      const before=requests, opened=page.waitForEvent('popup'); await node.click();
      const checkout=await opened; await checkout.waitForURL(original+'/official-'+offer); assert.equal(requests,before);
      await checkout.close(); await node.evaluate(element=>element.removeAttribute('target')); await page.clock.runFor(1);
    }
    await page.evaluate(()=>{document.querySelectorAll('a').forEach(a=>a.textContent='Acheter en français');(document.querySelector('#open') as HTMLButtonElement).click();});
    assert.equal(await click('vip00001'),original+'/official-vip');await page.clock.runFor(1);
    await capture.locator('[data-anticlone-surface=main] [data-anticlone-point=plus0001]').evaluate(node=>node.setAttribute('href','/changed-plus'));
    const changed=await capture.evaluate(()=>(window as unknown as {anticloneLabInventory:(surface:string)=>unknown[]}).anticloneLabInventory('main'));
    assert.equal((await post('inventory',{surface:'main',candidates:changed})).status,200);
    const drift=page.waitForResponse(r=>r.url().endsWith('/cta-refresh')); await page.clock.fastForward(60000); await drift; await page.clock.runFor(1);
    assert.equal(await click('plus0001'),clone+'/native-plus'); await page.clock.runFor(1);
    assert.equal(await click('classic01','sticky'),original+'/official-plus'); await page.clock.runFor(1);
    assert.equal(await click('vip00001'),original+'/official-vip'); await page.clock.runFor(1);
    await page.evaluate(()=>{history.pushState({},'', '/clone2');document.body.insertAdjacentHTML('beforeend','<div data-anticlone-surface="other"><a data-anticlone-point="route001" href="/native-route">Route</a></div>');});
    assert.equal(await click('plus0001'),clone+'/native-plus');await page.clock.runFor(1);
    const refresh=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));await page.clock.fastForward(5000);await refresh;await page.clock.runFor(1);
    assert.equal(await click('plus0001'),clone+'/native-plus');
    assert.equal(await click('route001','other'),original+'/official-route');
    const routeWithoutScope=await page.evaluate(()=>{const root=document.querySelector('[data-anticlone-surface=other]')!;root.removeAttribute('data-anticlone-surface');const node=root.querySelector<HTMLAnchorElement>('a')!;let href='';window.addEventListener('click',event=>{href=node.href;event.preventDefault();},{once:true});node.click();root.setAttribute('data-anticlone-surface','other');return href;});
    assert.equal(routeWithoutScope,clone+'/native-route');await page.clock.runFor(1);
    let release!:()=>void, seen!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;}), received=new Promise<void>(resolve=>{seen=resolve;});
    await page.route('**/cta-refresh',async route=>{try {const response=await route.fetch();seen();await hold;await route.fulfill({response});} catch { /* Aborted requests must not reactivate the old route. */ }});
    await page.evaluate(()=>history.pushState({},'', '/clone'));await page.clock.fastForward(5000);await received;
    await page.evaluate(()=>history.pushState({},'', '/clone2'));release();await page.clock.runFor(1);
    assert.equal(await click('route001','other'),clone+'/native-route');
    await page.unroute('**/cta-refresh');
    const renewed=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));await page.clock.fastForward(5000);await renewed;await page.clock.runFor(1);
    assert.equal(await click('route001','other'),original+'/official-route');
  } finally {
    if(browser) await browser.close();if(app && app.exitCode===null && app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}
    if(fixture?.listening)await new Promise<void>(r=>fixture!.close(()=>r()));if(admin?.listening)await new Promise<void>(r=>admin!.close(()=>r()));
    await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
