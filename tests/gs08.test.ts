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
test('GS08: real checkout drift isolates a CTA through authenticated review in Chromium', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='gs08_'+randomUUID().replaceAll('-','');
  const adminDb=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let fixture:ReturnType<typeof createServer>|undefined, admin:ReturnType<typeof createAdminServer>|undefined;
  let app:ReturnType<typeof spawn>|undefined, browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    for (const f of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    assert.equal((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='cta_drift_alerts'::regclass AND tgname='prepare_cta_alert_delivery'")).rowCount,0);
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
    const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1'); await once(admin,'listening');
    const adminUrl=`http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    const login=await fetch(`${adminUrl}/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(secret)}).generate()})});
    assert.equal(login.status,200); const {token}=await login.json() as {token:string};
    let html='<a data-anticlone-point="basic001" href="/native-basic">Basic</a><a data-anticlone-point="premium1" href="/native-premium">Premium</a><script src="http://127.0.0.1:3000/runtime.js"></script>';
    fixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url==='/clone'?html:'<h1>destination</h1>')).listen(0,'127.0.0.1'); await once(fixture,'listening');
    const port=(fixture.address() as AddressInfo).port, original=`http://127.0.0.1:${port}`, clone=`http://localhost:${port}`, project='gs08_'+randomUUID();
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    const post=(part:string,body:object,authenticated=true)=>fetch(`${adminUrl}/admin/projects/${project}/cta/${part}`,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    const candidates=['basic001','premium1'].map((marker,i)=>({marker,kind:'a',parent:'body',ordinal:i+1,url:clone+'/native-'+(i?'premium':'basic')}));
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
    await page.addInitScript(()=>{
      const add=document.addEventListener.bind(document);
      document.addEventListener=((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{
        add(type,listener,options);
        if(type==='click') document.documentElement.dataset.testCtaListener='installed';
      }) as typeof document.addEventListener;
    });
    const click=async (marker:string,expected:string)=>{
      const decision=page.waitForResponse(r=>r.url().endsWith('/entry-decision') && r.status()===200);
      await page.goto(clone+'/clone'); await decision;
      await page.waitForFunction(()=>document.documentElement.dataset.testCtaListener==='installed');
      await page.locator(`[data-anticlone-point="${marker}"]`).click(); await page.waitForURL(expected);
    };
    await click('basic001',original+'/official-basic'); await click('premium1',original+'/official-premium');
    html=html.replace('/native-basic','/changed');
    const changed=[{...candidates[0],url:clone+'/changed'},candidates[1]];
    await inventory(changed);
    await Promise.all([inventory(changed),inventory(changed)]);
    const state=async()=>db.query(`SELECT p.marker,p.review_required,m.destination_id FROM cta_points p JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id WHERE p.project_id=$1 ORDER BY p.marker`,[project]);
    assert.deepEqual((await state()).rows,[{marker:'basic001',review_required:true,destination_id:destinations.basic001},{marker:'premium1',review_required:false,destination_id:destinations.premium1}]);
    const point=points.find(x=>x.marker==='basic001').id;
    assert.deepEqual((await db.query('SELECT point_id,reason FROM cta_drift_alerts WHERE project_id=$1',[project])).rows,[{point_id:point,reason:'DESTINATION_CHANGED'}]);
    assert.deepEqual((await db.query('SELECT d.delivery_mode FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id WHERE a.project_id=$1',[project])).rows,[{delivery_mode:'SMTP_LOCAL'}]);
    await click('basic001',clone+'/changed'); await click('premium1',original+'/official-premium');
    const observation=(await db.query("SELECT id,confidence FROM cta_observations WHERE project_id=$1 AND point_id=$2 ORDER BY observed_at DESC,id DESC LIMIT 1",[project,point])).rows[0];
    assert.equal(observation.confidence,'HIGH');
    const review={pointId:point,destinationId:destinations.basic001,observationId:observation.id};
    assert.equal((await post('review',review,false)).status,401);
    assert.equal((await post('review',review)).status,200);
    assert.equal((await post('review',review)).status,400);
    assert.deepEqual((await db.query('SELECT point_id,observation_id,destination_id,observed_url FROM cta_review_audit WHERE project_id=$1',[project])).rows,[{point_id:point,observation_id:observation.id,destination_id:destinations.basic001,observed_url:clone+'/changed'}]);
    assert.deepEqual((await state()).rows,[{marker:'basic001',review_required:false,destination_id:destinations.basic001},{marker:'premium1',review_required:false,destination_id:destinations.premium1}]);
    await click('basic001',original+'/official-basic'); await click('premium1',original+'/official-premium');
  } finally {
    if (browser) await browser.close();
    if (app && app.exitCode===null && app.signalCode===null) {app.kill('SIGTERM'); await once(app,'exit');}
    if (fixture?.listening) await new Promise<void>(r=>fixture!.close(()=>r()));
    if (admin?.listening) await new Promise<void>(r=>admin!.close(()=>r()));
    await db.end(); await adminDb.query(`DROP SCHEMA ${schema} CASCADE`); await adminDb.end();
  }
});
