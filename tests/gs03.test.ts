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

const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
test('GS03: four synthetic offers mapped manually in Chromium', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='gs03_'+randomUUID().replaceAll('-','');
  const adminDb=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let fixture:ReturnType<typeof createServer>|undefined, admin:ReturnType<typeof createAdminServer>|undefined;
  let app:ReturnType<typeof spawn>|undefined, browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    for (const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','023_cta_commercial']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    assert.equal((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='cta_drift_alerts'::regclass AND tgname='prepare_cta_alert_delivery'")).rowCount,0);
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
    const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1'); await once(admin,'listening');
    const adminUrl=`http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    const login=await fetch(`${adminUrl}/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(secret)}).generate()})});
    assert.equal(login.status,200); const {token}=await login.json() as {token:string};
    const markers=['point001','point002','point003','point004','repeat01'];
    let html=markers.map((marker,i)=>'<section><a data-anticlone-point="'+marker+'" href="/native-'+i+'">Comprar 10 EUR</a></section>').join('')+'<a data-anticlone-point="unmapped" href="/unmapped">Comprar</a><aside><a href="/unmarked">Comprar 999 USD</a></aside><script src="http://127.0.0.1:3000/runtime.js"></script>';
    fixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url==='/clone'?html:'<h1>destination</h1>')).listen(0,'127.0.0.1'); await once(fixture,'listening');
    const port=(fixture.address() as AddressInfo).port, original=`http://127.0.0.1:${port}`, clone=`http://localhost:${port}`, project='gs03_'+randomUUID();
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    const post=(part:string,body:object,authenticated=true)=>fetch(`${adminUrl}/admin/projects/${project}/cta/${part}`,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    const capture=await browser.newPage();
    await capture.route('**/runtime.js',route=>route.abort());
    await capture.goto(clone+'/clone');
    await capture.addScriptTag({content:await readFile('runtime/cta-inventory.js','utf8')});
    const candidates=await capture.evaluate(()=> (window as unknown as {anticloneLabInventory:()=>{marker:string|null;url:string|null}[]}).anticloneLabInventory());
    assert.equal(candidates.length,7);
    assert.deepEqual(candidates.map(x=>[x.marker,x.url]),[...markers.map((marker,i)=>[marker,clone+'/native-'+i]),['unmapped',clone+'/unmapped'],[null,clone+'/unmarked']]);
    assert.equal((await post('inventory',{surface:'landing',candidates},false)).status,401);
    assert.equal((await post('inventory',{surface:'landing',candidates})).status,200);
    await capture.close();
    const points=(await db.query('SELECT id,marker FROM cta_points WHERE project_id=$1',[project])).rows;
    const destinations:Record<string,string>={};
    for (const [i,marker] of markers.entries()) {
      const offer='offer_'+(i===4?0:i);
      if(!destinations[offer]) {
        const response=await post('destinations',{offer,url:original+'/official-'+offer}); assert.equal(response.status,200);
        const {id}=await response.json() as {id:string}; destinations[offer]=id;
      }
      assert.equal((await post('mappings',{pointId:points.find(x=>x.marker===marker).id,offer,destinationId:destinations[offer]})).status,200);
    }
    const listed=await fetch(adminUrl+'/admin/projects/'+project+'/cta',{headers:{authorization:'Bearer '+token}});
    assert.equal(listed.status,200);
    const inventory=await listed.json() as {marker:string|null;observed_url:string;approved_url:string|null}[];
    for(const [i,marker] of markers.entries()) {
      const point=inventory.find(x=>x.marker===marker);
      assert.equal(point?.observed_url,clone+'/native-'+i);
      assert.equal(point?.approved_url,original+'/official-offer_'+(i===4?0:i));
    }
    assert.equal(inventory.find(x=>x.marker===null)?.approved_url,null);
    assert.equal((await post('policy',{enabled:true,surface:'landing',pathname:'/clone',allocation})).status,200);
    app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
    let ready=false; for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));} assert.ok(ready);
    const page=await browser.newPage();
    await page.addInitScript(()=>{
      const add=document.addEventListener.bind(document);
      document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
        add(type,listener,options);
        if(type==='click') document.documentElement.dataset.testCtaListener='installed';
      }) as typeof document.addEventListener;
    });
    let decisions=0; page.on('request',r=>{if(r.url().endsWith('/entry-decision')) decisions++;});
    const click=async (marker:string,expected:string)=>{
      const decision=page.waitForResponse(r=>r.url().endsWith('/entry-decision') && r.status()===200);
      await page.goto(clone+'/clone'); await decision;
      await page.waitForFunction(()=>document.documentElement.dataset.testCtaListener==='installed');
      const before=decisions;
      await page.locator(marker).click(); await page.waitForURL(expected); assert.equal(decisions,before);
    };
    const verify=async()=>{
      for(const [i,marker] of markers.entries()) await click('[data-anticlone-point="'+marker+'"]',original+'/official-offer_'+(i===4?0:i));
      await click('[data-anticlone-point="unmapped"]',clone+'/unmapped');
      await click('a:not([data-anticlone-point])',clone+'/unmarked');
    };
    await verify();
    html=html.replaceAll('Comprar 10 EUR','Purchase 9000 JPY');
    const script=html.indexOf('<script');
    html=html.slice(0,script).split(/(?=<section>)/).reverse().join('')+html.slice(script);
    html=html.replaceAll('<section>','<article><div>').replaceAll('</section>','</div></article>');
    await verify();
    html=html.replace('<script','<a data-anticlone-point="point001" href="/collision">Comprar</a><script');
    await click('[data-anticlone-point="point001"] >> nth=0',clone+'/native-0');
    await click('[data-anticlone-point="point004"]',original+'/official-offer_3');
  } finally {
    if (browser) await browser.close();
    if (app && app.exitCode===null && app.signalCode===null) {app.kill('SIGTERM'); await once(app,'exit');}
    if (fixture?.listening) await new Promise<void>(r=>fixture!.close(()=>r()));
    if (admin?.listening) await new Promise<void>(r=>admin!.close(()=>r()));
    await db.end(); await adminDb.query(`DROP SCHEMA ${schema} CASCADE`); await adminDb.end();
  }
});
