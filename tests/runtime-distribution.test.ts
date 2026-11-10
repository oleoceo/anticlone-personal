import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {distributionAdmin,distributionOrigins,readDistribution} from '../apps/runtime-distribution.js';
import {distributionGateway} from '../apps/distribution-gateway.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {observedSessionGateway} from '../apps/observed-session-gateway.js';
import {createAdminServer} from '../apps/admin-auth.js';
import {runtimeLayerObservations} from '../apps/runtime-layer-observations.js';
import {degradationState} from '../apps/degradation.js';
import {enableInstallation,recordInstallationClaim} from '../apps/installation.js';
import {projectMaintenance} from '../apps/project-maintenance.js';

test('distribution origins: one host defaults, explicit role assignment, private admin separation',()=>{
  const one=distributionOrigins({RUNTIME_PUBLIC_ORIGIN:'https://runtime.owner.test'});
  assert.equal(new Set(Object.values(one)).size,1);
  assert.equal(distributionOrigins({RUNTIME_PUBLIC_ORIGIN:one.SCRIPT,RUNTIME_TELEMETRY_ORIGIN:'https://signals.owner.test'}).TELEMETRY,'https://signals.owner.test');
  for(const value of ['https://a.test/','https://a.test/path','https://a.test?x=1','http://external.test','https://user:pass@a.test','https://a.test/<script>']) assert.throws(()=>distributionOrigins({RUNTIME_PUBLIC_ORIGIN:value}));
  assert.throws(()=>distributionOrigins({RUNTIME_PUBLIC_ORIGIN:one.SCRIPT,ADMIN_PUBLIC_ORIGIN:'https://runtime.owner.test:8443'}));
  assert.throws(()=>distributionOrigins({}));
});

test('distribution v1: persistent revisions, admin HTML/CSS, real browser layers, independent fallback and compatibility',{timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='distribution_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const pageId=randomUUID(),installation=randomUUID(),otherPage=randomUUID(),otherInstallation=randomUUID();
  let html='',css='';
  const site=createServer((req,res)=>res.writeHead(200,{'content-type':req.url==='/canary.css'?'text/css':'text/html'}).end(req.url==='/canary.css'?css:`<link rel="stylesheet" href="/canary.css"><div class="anticlone-canary">Owned LP</div><a href="/checkout">Checkout</a>${html}`)).listen(0,'127.0.0.1');
  await once(site,'listening');
  const origin='http://127.0.0.1:'+(site.address() as AddressInfo).port;
  const clone='http://localhost:'+(site.address() as AddressInfo).port;
  const scripts:Record<string,Buffer>={};
  for(const [route,file] of [['runtime.js','bootstrap.js'],['core.js','core.js'],['fallback.js','fallback.js'],['cta-inventory.js','cta-inventory.js']])scripts[route]=await readFile('runtime/'+file);
  const layers=runtimeLayerObservations(db,{SCOPED_LAB_INSTALLATION:installation,SCOPED_LAB_ORIGIN:clone});
  const legacy=scopedGateway(db,scripts,undefined,layers);
  const receipts=observedSessionGateway(db);
  const dispatch:Parameters<typeof distributionGateway>[2]=(req,res)=>{if(!receipts(req,res)&&!legacy(req,res))res.writeHead(404).end();};
  const distributed=distributionGateway(db,scripts,dispatch,layers);
  const gateway=createServer((req,res)=>{if(!distributed(req,res))dispatch(req,res);}).listen(0,'127.0.0.1');
  await once(gateway,'listening');
  const base='http://127.0.0.1:'+(gateway.address() as AddressInfo).port;
  const env={RUNTIME_PUBLIC_ORIGIN:base};
  const beforeEnv=process.env.RUNTIME_PUBLIC_ORIGIN;
  process.env.RUNTIME_PUBLIC_ORIGIN=base;
  const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1');
  await once(admin,'listening');
  const adminBase='http://127.0.0.1:'+(admin.address() as AddressInfo).port;
  const browser=await chromium.launch();
  const request={project:'one',page:pageId,action:'inspect'};
  try{
    for(const file of (await readdir('infra')).filter(file=>/^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0,3))<53).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    await db.query("INSERT INTO projects VALUES('one','One',$1),('two','Two','http://localhost:10001')",[origin]);
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'one',$2,'LP'),($3,'two',$4,'Other')",[pageId,installation,otherPage,otherInstallation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,'/')",[pageId,origin]);
    await enableInstallation(db,'one');
    await recordInstallationClaim(db,'one',origin,'core');
    assert.equal((await distributionAdmin(db,request,env)).state,'NOT_PUBLISHED');
    assert.equal((await db.query('SELECT count(*)::int n FROM runtime_aliases')).rows[0].n,0);
    await assert.rejects(distributionAdmin(db,{...request,project:'two',action:'publish'},env));
    const published=await Promise.all([1,2].map(()=>distributionAdmin(db,{...request,action:'publish'},env)));
    const first=published[0].distribution;assert.ok(first);
    assert.deepEqual(published[1].distribution,first);
    assert.equal(first.version,1);
    assert.equal((await db.query('SELECT count(*)::int n FROM runtime_aliases')).rows[0].n,3);
    for(const [role,path]of [['SCRIPT','observe'],['TELEMETRY','runtime.js'],['STATIC_ASSETS','entry-decision']] as const)assert.equal((await fetch(first.bases[role]+path)).status,404);
    assert.equal((await fetch(base+'/d/v2/'+randomUUID()+'/runtime.js')).status,404);
    assert.equal((await fetch(base+'/d/v1/'+randomUUID()+'/runtime.js')).status,404);
    assert.equal((await fetch(base+'/i/'+installation+'/runtime.js')).status,200);
    assert.equal((await fetch(first.bases.SCRIPT+'runtime.js',{method:'POST'})).status,405);
    // Authenticated panel generates exactly the persisted snippets; reads never rotate.
    assert.equal((await fetch(adminBase+'/admin/ui/distribution',{method:'POST'})).status,403);
    assert.equal((await fetch(adminBase+'/admin/ui/operational',{method:'POST'})).status,403);
    const panel=await browser.newPage();await panel.goto(adminBase+'/admin/ui/');
    await panel.getByLabel('Senha administrativa').fill('password');
    await panel.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());
    await panel.getByRole('button',{name:'Entrar',exact:true}).click();
    await panel.locator('#distribution-form').waitFor();
    await panel.getByLabel('Projeto da instalação',{exact:true}).fill('one');
    await panel.getByLabel('LP da instalação',{exact:true}).fill(pageId);
    await panel.getByRole('button',{name:'Consultar distribuição',exact:true}).click();
    await panel.waitForFunction(()=>!!(document.querySelector('#distribution-html') as HTMLTextAreaElement).value);
    html=await panel.getByLabel('HTML de instalação',{exact:true}).inputValue();
    css=await panel.getByLabel('CSS de instalação',{exact:true}).inputValue();
    assert.equal(html,published[0].snippets?.html);assert.equal(css,published[0].snippets?.css);
    const page=await browser.newPage();
    const responses=Promise.all(['observe','observe/fallback','html.gif','css.gif'].map(path=>page.waitForResponse(response=>response.url().endsWith('/'+path)&&response.ok())));
    await page.goto(origin);await responses;
    const signals=(await db.query('SELECT source FROM page_installation_signals WHERE page_id=$1 ORDER BY source',[pageId])).rows.map(row=>row.source);
    assert.deepEqual(signals,['core','fallback']);
    assert.ok((await db.query("SELECT last_activity_at FROM installation_last_signal WHERE project_id='one'")).rows[0].last_activity_at,'F45 retains origin-level alleged activity without certifying a LP');
    const state=await distributionAdmin(db,request,env);assert.equal(state.diagnostic?.status,'NOT_VERIFIED');
    assert.equal(state.diagnostic?.layers.find(layer=>layer.layer==='bootstrap')?.status,'UNKNOWN');
    assert.equal(state.diagnostic?.controlledVerification.status,'NOT_VERIFIED');
    assert.equal(state.diagnostic?.capabilities.activeMitigation,'UNKNOWN');
    // Another LP on the same host cannot be inferred from an origin-only
    // Referer or a copied snippet. Alias routing is not execution evidence.
    const sibling=randomUUID(),siblingInstallation=randomUUID();
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'one',$2,'Sibling')",[sibling,siblingInstallation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,'/second')",[sibling,origin]);
    const siblingDistribution=await distributionAdmin(db,{project:'one',page:sibling,action:'publish'},env);
    assert.ok(siblingDistribution.distribution);
    for(const referer of [undefined,origin+'/',origin+'/wrong','https://forged.test/second']){
      const r:Response=await fetch(siblingDistribution.distribution.bases.STATIC_ASSETS+'html.gif',{headers:referer?{referer}:{}});assert.equal(r.status,200);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM page_installation_signals WHERE page_id=$1',[sibling])).rows[0].n,0);
    await fetch(siblingDistribution.distribution.bases.STATIC_ASSETS+'html.gif',{headers:{referer:origin+'/second'}});
    const forged=await distributionAdmin(db,{project:'one',page:sibling,action:'inspect'},env);
    assert.equal(forged.diagnostic?.status,'NOT_VERIFIED','even an exact forged header proves no execution');
    assert.equal(forged.diagnostic?.confidence,'UNAUTHENTICATED_CLAIM');
    // Remove Bootstrap and Core: the independently installed Fallback still sends.
    await page.route('**/runtime.js',route=>route.abort());await page.route('**/core.js',route=>route.abort());
    const fallback=page.waitForResponse(response=>response.url()===first.bases.TELEMETRY+'observe/fallback'&&response.status()===204);
    await page.reload();await fallback;
    assert.equal(await page.getByRole('link',{name:'Checkout'}).getAttribute('href'),'/checkout');
    // The same independently installed layers feed the existing F44 journal.
    const copied=await browser.newPage();
    await copied.goto(clone);
    const wait=async(check:()=>Promise<boolean>)=>{for(let index=0;index<100;index++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('layer journal did not settle');};
    await wait(async()=>(await db.query("SELECT count(DISTINCT source)::int n FROM degradation_events WHERE project_id='one' AND origin=$1",[clone])).rows[0].n===4);
    assert.equal(await degradationState(db,'one','localhost',clone),'UNKNOWN','restart gap prevents immediate inference');
    // Age real committed samples rather than waiting 31 minutes. Same F44 contract.
    const aging=await db.connect();
    try{
      await aging.query('BEGIN');
      await aging.query("UPDATE degradation_collection_gaps SET last_dropped_at=now()-interval '31 minutes' WHERE project_id='one'");
      await aging.query("UPDATE degradation_events SET observed_at=now()-interval '20 minutes',bucket=date_trunc('minute',now()-interval '20 minutes') WHERE project_id='one' AND source='core'");
      await aging.query("INSERT INTO degradation_events(project_id,host,source,bucket,origin,observed_at) SELECT project_id,host,source,date_trunc('minute',now()-interval '21 minutes'),origin,now()-interval '21 minutes' FROM degradation_events WHERE project_id='one' AND source='core'");
      await aging.query("UPDATE degradation_events SET observed_at=now()-interval '3 minutes',bucket=date_trunc('minute',now()-interval '3 minutes') WHERE project_id='one' AND source<>'core'");
      await aging.query('COMMIT');
    }catch(error){await aging.query('ROLLBACK');throw error;}finally{aging.release();}
    await copied.route('**/core.js',route=>route.abort());await copied.reload();
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='one' AND origin=$1",[clone])).rows[0].n>=8);
    assert.equal(await degradationState(db,'one','localhost',clone),'POSSIBLE_DEGRADATION');
    await copied.close();
    await db.query("DELETE FROM degradation_events WHERE project_id='one' AND source='fallback'");
    await projectMaintenance(db,{SCOPED_LAB_INSTALLATION:installation,SCOPED_LAB_ORIGIN:clone,SMTP_PORT:'1'})();
    assert.equal((await db.query("SELECT state FROM degradation_audit WHERE project_id='one' AND host='localhost' ORDER BY observed_at DESC LIMIT 1")).rows[0].state,'POSSIBLE_DEGRADATION','maintenance retains canary correlation');
    await db.query("CREATE FUNCTION fail_runtime_observe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled collection loss'; END $$; CREATE TRIGGER fail_runtime_observe BEFORE INSERT ON incidents FOR EACH ROW EXECUTE FUNCTION fail_runtime_observe()");
    const lost=await fetch(first.bases.TELEMETRY+'observe',{method:'POST',headers:{origin:clone,'content-type':'text/plain'},body:JSON.stringify({origin:clone,pathname:'/',signals:{}})});
    assert.equal(lost.status,503);
    await wait(async()=>(await db.query("SELECT count(*)::int n FROM degradation_collection_gaps WHERE project_id='one' AND last_dropped_at>now()-interval '1 minute'")).rows[0].n===1);
    await db.query('DROP TRIGGER fail_runtime_observe ON incidents; DROP FUNCTION fail_runtime_observe()');
    assert.equal(await degradationState(db,'one','localhost',clone),'UNKNOWN','known loss invalidates the baseline');
    assert.equal((await db.query("SELECT count(*)::int n FROM degradation_events WHERE project_id='one' AND source='core'")).rows[0].n,2,'lost collection never invents a core observation');
    // Explicit new role origins create v2; old bundles retain all v1 bases.
    const second=await distributionAdmin(db,{...request,action:'publish'},{...env,RUNTIME_TELEMETRY_ORIGIN:'https://signals.owner.test'});
    assert.equal(second.distribution?.version,2);
    assert.deepEqual(await readDistribution(db,installation,1),first);
    const oldBundle=await (await fetch(first.bases.SCRIPT+'runtime.js')).text();
    assert.ok(oldBundle.includes(first.bases.TELEMETRY));assert.ok(!oldBundle.includes('https://signals.owner.test'));
    await db.query(await readFile('infra/053_distribution_rotation.sql','utf8'));
    const rotationEnv={...env,RUNTIME_TELEMETRY_ORIGIN:'https://signals.owner.test'};
    const rotated=await distributionAdmin(db,{...request,action:'rotate'},rotationEnv);
    assert.equal(rotated.distribution?.version,3);
    assert.ok(rotated.distribution?.paths);
    assert.equal((await fetch(rotated.distribution!.bases.SCRIPT+'a.js')).status,200);
    assert.equal((await fetch(base+new URL(rotated.distribution!.bases.TELEMETRY).pathname+'a.js')).status,404);
    assert.equal((await fetch(rotated.distribution!.bases.STATIC_ASSETS+'g')).status,404);
    assert.notEqual(rotated.distribution?.bases.SCRIPT,second.distribution?.bases.SCRIPT);
    assert.equal(new URL(rotated.distribution!.bases.SCRIPT).origin,new URL(second.distribution!.bases.SCRIPT).origin);
    assert.equal(rotated.history?.[0].reason,'rotate');
    assert.deepEqual((await distributionAdmin(db,request,rotationEnv)).distribution,rotated.distribution);
    assert.deepEqual(await readDistribution(db,installation,2),second.distribution);
    const modern=await distributionAdmin(db,{...request,action:'rotate'},env);assert.ok(modern.snippets);assert.ok(modern.distribution);
    html=modern.snippets.html;css=modern.snippets.css;
    await page.unroute('**/runtime.js');await page.unroute('**/core.js');
    const modernLayers=Promise.all(['e','f','m.gif','n.gif'].map(path=>page.waitForResponse(r=>r.url().endsWith('/'+path)&&r.ok())));
    await page.goto(origin);await modernLayers;
    const routed=await distributionAdmin(db,request,env);
    assert.equal(routed.aliasActivity?.length,2,'sources remain distinct even sharing a routing alias');
    for(const layer of ['html_canary','css_canary'])assert.equal(routed.diagnostic?.layers.find(l=>l.layer===layer)?.status,'ROUTE_OBSERVED');
    assert.equal(routed.diagnostic?.status,'NOT_VERIFIED');
    for(const target of ['http://127.0.0.1/','http://169.254.169.254/','https://unapproved.test/'])await assert.rejects(distributionAdmin(db,{...request,action:'verify',url:target},env),TypeError);
    await assert.rejects(db.query('UPDATE runtime_aliases SET origin=$1 WHERE installation_id=$2',[base,installation]));
    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='one'");
    const paused=await fetch(first.bases.TELEMETRY+'observe/fallback',{method:'POST',headers:{origin,'content-type':'text/plain'},body:JSON.stringify({origin,pathname:'/'})});assert.equal(paused.status,204);
    assert.equal((await db.query('SELECT count(*)::int n FROM page_installation_signals WHERE project_id=$1',['two'])).rows[0].n,0);
    // Backend outage preserves the page and native checkout.
    await page.route(base+'/**',route=>route.abort());await page.reload();
    assert.equal(await page.getByRole('link',{name:'Checkout'}).getAttribute('href'),'/checkout');
  }finally{
    if(beforeEnv===undefined)delete process.env.RUNTIME_PUBLIC_ORIGIN;else process.env.RUNTIME_PUBLIC_ORIGIN=beforeEnv;
    await browser.close();for(const server of [site,gateway,admin]){server.close();await once(server,'close');}
    await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
