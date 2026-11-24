import {checkTelemetryEndpoint, distributionHealthPath, listTelemetryOrigins, telemetryOriginAdmin} from '../apps/telemetry-origins.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createServer,type RequestListener} from 'node:http';
import {createServer as createHttpsServer, request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {SMTPServer} from 'smtp-server';
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
import {PublicDnsFailure,type VerificationRequest,type VerificationResponse} from '../apps/installation-verifier.js';
import {gatewayBoundary} from '../apps/gateway-boundary.js';
import {npmServer} from '../apps/npm-transport.js';
import {syntheticTls} from './npm-fixture.js';
import {deliverOne} from '../apps/alerts.js';

test('endpoint readiness requires DNS, HTTPS and the operational health reply',async()=>{
  const origin='https://signals.owner.test';
  const probes=[
    [new PublicDnsFailure(), 'DNS_FAILED'],
    [new Error('certificate invalid'), 'HTTPS_FAILED'],
    [{status:502}, 'GATEWAY_NOT_READY'],
    [{status:302}, 'GATEWAY_NOT_READY'],
    [{status:200,body:'{"status":"ready","mode":"PILOT_OBSERVE","action":"OBSERVE_ONLY"}'}, 'GATEWAY_NOT_READY'],
    [{status:200,body:'{"status":"ready","mode":"OPERATIONAL","action":"SCOPED_AUTHORIZATION_REQUIRED"}'}, 'OPERATIONAL'],
  ] as const;
  for(const [probe,expected] of probes){
    assert.equal(await checkTelemetryEndpoint(origin,async request=>{
      assert.deepEqual(request,{url:origin+distributionHealthPath,method:'GET',body:''});
      if(probe instanceof Error)throw probe;
      return {status:probe.status,headers:{'content-type':'application/json'},body:Buffer.from('body' in probe?probe.body:'')};
    }),expected);
  }
});

async function sharedMtlsIngress(origins: readonly string[], dispatch: RequestListener) {
  const dir=await mkdtemp(join(tmpdir(),'anticlone-endpoints-'));
  const env=await syntheticTls(dir);
  const boundary=gatewayBoundary(env);
  const server=npmServer(env,(req,res)=>{
    if(!boundary(req,res))return;
    if(req.url===distributionHealthPath){
      res.writeHead(200,{'content-type':'application/json'}).end('{"status":"ready","mode":"OPERATIONAL","action":"SCOPED_AUTHORIZATION_REQUIRED"}');
    }else dispatch(req,res);
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  const [ca,cert,key]=await Promise.all(['server.crt','proxy.crt','proxy.key'].map(file=>readFile(join(dir,file))));
  const ingress = {
    // Reproduces the ingress contract: approved external vhosts share one mTLS upstream and canonical Host/SNI.
    request({url,method,body}:VerificationRequest,origin?:string):Promise<VerificationResponse>{
      const target=new URL(url);
      assert.ok(origins.includes(target.origin));
      return new Promise((resolve,reject)=>{
        const req=httpsRequest({hostname:'127.0.0.1',port,servername:env.PUBLIC_GATEWAY_HOST,ca,cert,key,method,
          path:target.pathname,headers:{host:env.PUBLIC_GATEWAY_HOST,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1',
            ...(origin ? {origin,'content-type':'text/plain'} : {})}},res=>{
          const chunks:Buffer[]=[];
          res.on('data',chunk=>chunks.push(chunk));
          res.on('error',reject);
          res.on('end',()=>resolve({status:res.statusCode!,headers:Object.fromEntries(
            ['content-type','access-control-allow-origin'].flatMap(name=>typeof res.headers[name]==='string'?[[name,res.headers[name]]]:[])),
          body:Buffer.concat(chunks)}));
        });
        req.on('error',reject);req.end(body);
      });
    },
  };
  const edges = await Promise.all(origins.map(async origin => {
    const edge = createHttpsServer({key:await readFile(env.NPM_TLS_KEY_FILE),cert:ca}, async (req,res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {res.writeHead(405).end();return;}
      const chunks:Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const reply = await ingress.request({url:origin+req.url,method:req.method,body:Buffer.concat(chunks).toString()},req.headers.origin);
        res.writeHead(reply.status, reply.headers).end(reply.body);
      } catch {
        res.writeHead(502).end();
      }
    }).listen(0,'127.0.0.1');
    await once(edge,'listening');
    return {edge,rule:'MAP '+new URL(origin).hostname+' 127.0.0.1:'+(edge.address() as AddressInfo).port};
  }));
  return {
    ...ingress,
    resolverRules:edges.map(({rule})=>rule).join(','),
    async close(){
      for (const listener of [...edges.map(({edge})=>edge),server]) {
        listener.closeAllConnections();
        await new Promise<void>(resolve=>listener.close(()=>resolve()));
      }
      await rm(dir,{recursive:true,force:true});
    },
  };
}

test('distribution origins: one host defaults, explicit role assignment, private admin separation',()=>{
  const one=distributionOrigins({RUNTIME_PUBLIC_ORIGIN:'https://runtime.owner.test'});
  assert.equal(new Set(Object.values(one)).size,1);
  assert.equal(distributionOrigins({RUNTIME_PUBLIC_ORIGIN:one.SCRIPT,RUNTIME_TELEMETRY_ORIGIN:'https://signals.owner.test'}).TELEMETRY,'https://signals.owner.test');
  for(const value of ['https://a.test/','https://a.test/path','https://a.test?x=1','http://external.test','https://user:pass@a.test','https://a.test/<script>']) assert.throws(()=>distributionOrigins({RUNTIME_PUBLIC_ORIGIN:value}));
  assert.throws(()=>distributionOrigins({RUNTIME_PUBLIC_ORIGIN:one.SCRIPT,ADMIN_PUBLIC_ORIGIN:'https://runtime.owner.test:8443'}));
  assert.throws(()=>distributionOrigins({}));
});

test('distribution: persistent v1/v2 and compact revisions, admin HTML/CSS, HTTPS and real browser layers',{timeout:90000},async()=>{
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
  const env={RUNTIME_PUBLIC_ORIGIN:base,RUNTIME_COMPACT_ALIASES:'true'};
  const beforeEnv=process.env.RUNTIME_PUBLIC_ORIGIN;
  const beforeCompact=process.env.RUNTIME_COMPACT_ALIASES;
  process.env.RUNTIME_COMPACT_ALIASES='true';
  const beforePool=process.env.RUNTIME_TELEMETRY_POOL_ORIGINS;
  process.env.RUNTIME_PUBLIC_ORIGIN=base;
  const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1');
  await once(admin,'listening');
  const adminBase='http://127.0.0.1:'+(admin.address() as AddressInfo).port;
  const browser=await chromium.launch();
  const request={project:'one',page:pageId,action:'inspect'};
  let ingress:Awaited<ReturnType<typeof sharedMtlsIngress>>|undefined;
  try{
    for(const file of (await readdir('infra')).filter(file=>/^\d{3}_.+\.sql$/.test(file) && (Number(file.slice(0,3))<53 || Number(file.slice(0,3))===54)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    await db.query("INSERT INTO projects VALUES('one','One',$1),('two','Two','http://localhost:10001')",[origin]);
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'one',$2,'LP'),($3,'two',$4,'Other')",[pageId,installation,otherPage,otherInstallation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,'/')",[pageId,origin]);
    await enableInstallation(db,'one');
    await recordInstallationClaim(db,'one',origin,'core');
    const blocked=await distributionAdmin(db,request,{});
    assert.equal(blocked.state,'NOT_PUBLISHED');
    assert.equal(blocked.publication.ready,false);
    assert.deepEqual(blocked.publication.issues.map(issue=>issue.code),Array(3).fill('RUNTIME_ORIGIN_MISSING'));
    await assert.rejects(distributionAdmin(db,{...request,action:'publish'},{}),{code:'RUNTIME_ORIGIN_MISSING'});
    assert.equal((await distributionAdmin(db,request,env)).publication.ready,true);
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
    const wait=async(check:()=>Promise<boolean>)=>{for(let index=0;index<100;index++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('layer journal did not settle');};
    const bootstrapStatus = async () => (await distributionAdmin(db,request,env)).diagnostic?.layers.find(layer=>layer.layer==='bootstrap')?.status;
    await wait(async()=>await bootstrapStatus()==='ROUTE_OBSERVED');
    const state=await distributionAdmin(db,request,env);assert.equal(state.diagnostic?.status,'NOT_VERIFIED');
    assert.equal(state.diagnostic?.layers.find(layer=>layer.layer==='bootstrap')?.controlled,'NOT_TESTED');
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
    assert.equal(forged.diagnostic?.layers.find(layer=>layer.layer==='bootstrap')?.status,'UNKNOWN');
    // Remove Bootstrap and Core: the independently installed Fallback still sends.
    await page.route('**/runtime.js',route=>route.abort());await page.route('**/core.js',route=>route.abort());
    const fallback=page.waitForResponse(response=>response.url()===first.bases.TELEMETRY+'observe/fallback'&&response.status()===204);
    await page.reload();await fallback;
    assert.equal(await page.getByRole('link',{name:'Checkout'}).getAttribute('href'),'/checkout');
    // The same independently installed layers feed the existing F44 journal.
    const copied=await browser.newPage();
    await copied.goto(clone);
    await wait(async()=>(await db.query("SELECT count(DISTINCT source)::int n FROM degradation_events WHERE project_id='one' AND origin=$1",[clone])).rows[0].n===4);
    await wait(async()=>(await db.query("SELECT count(DISTINCT source)::int n FROM investigation_receipts WHERE project_id='one' AND page_id=$1 AND claimed_host='localhost' AND alias IS NOT NULL",[pageId])).rows[0].n===4);
    const linked=(await db.query("SELECT DISTINCT installation_id,page_id FROM investigation_receipts WHERE project_id='one' AND claimed_host='localhost'")).rows;
    assert.deepEqual(linked,[{installation_id:installation,page_id:pageId}]);
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
    assert.equal(await bootstrapStatus(),'UNKNOWN','a receipt for the previous revision cannot count for the new alias');
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
    await wait(async()=>await bootstrapStatus()==='ROUTE_OBSERVED');
    const routed=await distributionAdmin(db,request,env);
    assert.equal(routed.aliasActivity?.length,2,'sources remain distinct even sharing a routing alias');
    for(const layer of ['html_canary','css_canary'])assert.equal(routed.diagnostic?.layers.find(l=>l.layer===layer)?.status,'ROUTE_OBSERVED');
    assert.equal(routed.diagnostic?.status,'NOT_VERIFIED');
    await db.query(await readFile('infra/067_telemetry_origins.sql','utf8'));
    const pooledOrigin = 'https://signals-pool.owner.test';
    const secondary = 'https://signals-secondary.owner.test';
    await db.query(await readFile('infra/068_telemetry_origin_checks.sql','utf8'));
    const settings=adminBase+'/admin/ui/novo/configuracoes/integracoes';
    const installationPath=adminBase+'/admin/ui/novo/projetos/one/lps/'+pageId+'/instalacao';
    await panel.goto(installationPath);
    const bootstrapLayer=panel.locator('.layers li').filter({has:panel.getByText('Bootstrap',{exact:true})});
    await bootstrapLayer.getByText('Acesso ao recurso observado',{exact:true}).waitFor();
    await bootstrapLayer.getByText('Sem prova controlada atual',{exact:true}).waitFor();
    const previous=(await distributionAdmin(db,request,env)).distribution!;
    const split=await distributionAdmin(db,{project:'one',page:sibling,action:'publish'},
      {...env,RUNTIME_TELEMETRY_ORIGIN:pooledOrigin});
    await panel.goto(settings);
    await panel.getByLabel('Origem HTTPS').fill(pooledOrigin);
    await panel.getByRole('button',{name:'Cadastrar endpoint',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    await panel.getByText('Aguardando autorização no ambiente privado',{exact:true}).waitFor();
    await panel.goto(installationPath);
    const pendingOption=panel.getByLabel('Endpoint de telemetria').locator('option').filter({hasText:pooledOrigin});
    await pendingOption.waitFor({state:'attached'});
    assert.notEqual(await pendingOption.getAttribute('disabled'),null);
    assert.match(await pendingOption.textContent() ?? '',/Aguardando autorização/);
    await panel.goto(settings);
    const pooledEnv = {...env,RUNTIME_TELEMETRY_POOL_ORIGINS:[pooledOrigin,secondary].join(',')};
    assert.equal((await listTelemetryOrigins(db,env)).items[0].authorized,false);
    for (const origin of ['http://signals.test','https://user@signals.test','https://127.0.0.1','https://signals.test/path','https://invalid..test','https://signals.test:8443']) {
      await assert.rejects(telemetryOriginAdmin(db,{action:'register',origin},env),TypeError);
    }
    await assert.rejects(distributionAdmin(db,{...request,action:'publish',telemetryOrigin:pooledOrigin},env),
      {code:'TELEMETRY_ORIGIN_UNAVAILABLE'});
    await assert.rejects(telemetryOriginAdmin(db,{action:'verify',origin:pooledOrigin},env,
      async()=>{assert.fail('Unapproved origin was probed');}),TypeError);
    assert.equal((await listTelemetryOrigins(db,{...pooledEnv,ADMIN_PUBLIC_ORIGIN:pooledOrigin})).items[0].authorized,false);
    process.env.RUNTIME_TELEMETRY_POOL_ORIGINS=pooledEnv.RUNTIME_TELEMETRY_POOL_ORIGINS;
    await panel.reload();
    await panel.getByText('Aguardando verificação do endpoint',{exact:true}).waitFor();
    await assert.rejects(distributionAdmin(db,{...request,action:'publish',telemetryOrigin:pooledOrigin},pooledEnv),
      {code:'TELEMETRY_ORIGIN_UNAVAILABLE'});
    await telemetryOriginAdmin(db,{action:'verify',origin:pooledOrigin},pooledEnv,async()=> 'GATEWAY_NOT_READY');
    await panel.reload();
    await panel.getByText('Gateway indisponível no endpoint',{exact:true}).waitFor();
    await panel.getByLabel('Origem HTTPS').fill(secondary);
    await panel.getByRole('button',{name:'Cadastrar endpoint',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    await panel.getByText(secondary,{exact:true}).waitFor();
    ingress=await sharedMtlsIngress([pooledOrigin,secondary],(req,res)=>{
      if(!distributed(req,res))dispatch(req,res);
    });
    const upstream=ingress;
    // Preserve a v2 revision on the first HTTPS origin across the migration.
    await telemetryOriginAdmin(db,{action:'verify',origin:pooledOrigin},pooledEnv,async()=> 'OPERATIONAL');
    const oldHttps = (await distributionAdmin(db,{...request,action:'publish',telemetryOrigin:pooledOrigin},pooledEnv)).distribution!;
    assert.match(oldHttps.bases.SCRIPT,/\/r\/v2\//);
    await db.query(await readFile('infra/075_compact_distribution_aliases.sql','utf8'));
    await assert.rejects(distributionAdmin(db,{...request,action:'rotate',telemetryOrigin:pooledOrigin},pooledEnv),
      {code:'TELEMETRY_ORIGIN_UNAVAILABLE'});
    for (const origin of [pooledOrigin,secondary]) {
      await telemetryOriginAdmin(db,{action:'verify',origin},pooledEnv,origin=>checkTelemetryEndpoint(origin,upstream.request));
    }
    const implicit=await distributionAdmin(db,{project:'one',page:sibling,action:'rotate'},pooledEnv);
    for (const role of ['SCRIPT','TELEMETRY','STATIC_ASSETS'] as const) {
      assert.equal(new URL(implicit.distribution!.bases[role]).origin,new URL(split.distribution!.bases[role]).origin);
    }
    await assert.rejects(distributionAdmin(db,{project:'one',page:sibling,action:'rotate'},
      {...pooledEnv,ADMIN_PUBLIC_ORIGIN:base}),{code:'RUNTIME_ADMIN_HOST_CONFLICT'});
    assert.deepEqual(await readDistribution(db,siblingInstallation),implicit.distribution);
    await panel.goto(adminBase+'/admin/ui/novo/projetos/one/lps/'+sibling+'/instalacao');
    assert.equal(await panel.getByLabel('Endpoint de telemetria').inputValue(),'current');
    await panel.getByLabel('Endpoint de telemetria').selectOption(pooledOrigin);
    await panel.getByRole('button',{name:'Publicar endereços de instalação',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    await panel.getByRole('region',{name:'Trecho HEAD'}).locator('code').filter({hasText:pooledOrigin+'/assets/'}).waitFor();
    const aligned=(await readDistribution(db,siblingInstallation))!;
    assert.equal(aligned.version,implicit.distribution!.version+1);
    assert.deepEqual(new Set(Object.values(aligned.bases).map(url=>new URL(url).origin)),new Set([pooledOrigin]));
    assert.deepEqual(await readDistribution(db,siblingInstallation,implicit.distribution!.version),implicit.distribution);
    await panel.goto(installationPath);
    const select=panel.getByLabel('Endpoint de telemetria');
    await select.selectOption(pooledOrigin);
    await panel.getByText('Diagnóstico avançado e histórico de revisões', {exact:true}).click();
    await panel.getByRole('button',{name:'Publicar nova revisão',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    const snippet=panel.getByRole('region',{name:'Trecho HEAD'}).locator('code');
    await snippet.filter({hasText:pooledOrigin+'/assets/'}).waitFor();
    const pooled = await distributionAdmin(db,request,pooledEnv);
    assert.ok(pooled.distribution?.paths);
    assert.deepEqual(new Set(Object.values(pooled.distribution.bases).map(url=>new URL(url).origin)),new Set([pooledOrigin]));
    const installedHtml=[await snippet.textContent(),await panel.getByRole('region',{name:'Trecho BODY'}).locator('code').textContent()].join('\n');
    assert.equal(installedHtml,pooled.snippets?.html);
    const demo=process.env.TELEMETRY_DEMO_DIR;
    if (demo) {
      await mkdir(demo,{recursive:true});
      await writeFile(join(demo,'snippet-index.html.txt'),installedHtml);
      await panel.screenshot({path:join(demo,'instalacao.png'),fullPage:true});
    }
    const pooledBundle = await upstream.request({url:pooled.distribution.bases.SCRIPT+'a.js',method:'GET',body:''});
    assert.equal(pooledBundle.status,200);
    assert.ok(pooledBundle.body.includes(pooled.distribution.bases.TELEMETRY));
    const input=JSON.stringify({origin,pathname:'/',signals:{}});
    assert.equal((await upstream.request({url:pooled.distribution.bases.TELEMETRY+'e',method:'POST',body:input},origin)).status,204);
    // Put the exact HTML from the panel into a controlled original and copy.
    const mailPage=await browser.newPage();
    const mailCopy='https://mail-copy.owner.test/';
    const copyHost=new URL(mailCopy).hostname;
    const previousHtml=html;
    html=(await snippet.textContent())!;
    const messages:string[]=[];
    const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS','AUTH'],
      onData(stream,_session,done){
        let message='';
        stream.on('data',chunk=>{message+=String(chunk);});
        stream.on('end',()=>{messages.push(message);done();});
      }});
    smtp.listen(0,'127.0.0.1');
    await once(smtp.server,'listening');
    try {
      await mailPage.route(mailCopy,route=>route.fulfill({contentType:'text/html',body:'<a href="/checkout">Checkout</a>'+html}));
      await mailPage.route(pooledOrigin+'/**',async route=>{
        const req=route.request();
        const method=req.method();
        assert.ok(method==='GET'||method==='POST');
        const answer=await upstream.request({url:req.url(),method,body:req.postData()??''},req.headers().origin);
        await route.fulfill({status:answer.status,headers:answer.headers,body:answer.body});
      });
      const visit=async(url:string)=>{
        const signal=mailPage.waitForResponse(response=>response.url()===pooled.distribution!.bases.TELEMETRY+'e' &&
          response.request().method()==='POST' && response.status()===204);
        await mailPage.goto(url);
        await signal;
        assert.equal(await mailPage.getByRole('link',{name:'Checkout'}).getAttribute('href'),'/checkout');
      };
      const incidentCount=async()=> (await db.query('SELECT count(*)::int AS count FROM incidents WHERE project_id=$1',['one'])).rows[0].count;
      const before=await incidentCount();
      await visit(origin);
      assert.equal(await incidentCount(),before,'no new incident on the authorized origin');
      await visit(mailCopy);
      await visit(mailCopy);
      assert.equal(await incidentCount(),before+1,'repeated visits deduplicate the new copy incident');
      await db.query(`UPDATE alert_outbox a SET expired_at=clock_timestamp() FROM incidents i
        WHERE a.incident_id=i.id AND i.project_id='one' AND i.host<>$1 AND a.sent_at IS NULL AND a.expired_at IS NULL`,[copyHost]);
      await deliverOne(db,'one',(smtp.server.address() as AddressInfo).port);
      await deliverOne(db,'one',(smtp.server.address() as AddressInfo).port);
      const delivery=(await db.query(`SELECT d.outcome,d.transport FROM clone_delivery_attempts d
        JOIN alert_outbox a ON a.id=d.outbox_id JOIN incidents i ON i.id=a.incident_id
        WHERE i.project_id='one' AND i.host=$1`,[copyHost])).rows;
      assert.deepEqual(delivery,[{outcome:'ACCEPTED',transport:'SMTP_LOCAL'}]);
      assert.equal(messages.length,1);
      assert.match(messages[0],/mail-copy\.owner\.test/);
      if(demo)await writeFile(join(demo,'e2e-email.json'),JSON.stringify({endpoint:pooledOrigin,
        originalNewIncidents:0,copyVisits:2,copyIncidents:1,acceptedEmails:1,delivery:delivery[0]},null,2)+'\n');
    }finally{
      html=previousHtml;
      await mailPage.close();
      await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    }
    assert.deepEqual(await readDistribution(db,installation,previous.version),previous);
    assert.equal((await distributionAdmin(db,request,pooledEnv)).publication.changesRequired,false);
    await select.selectOption(secondary);
    await panel.getByRole('button',{name:'Publicar endereços de instalação',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    await snippet.filter({hasText:secondary}).waitFor();
    const next=(await distributionAdmin(db,request,pooledEnv)).distribution!;
    assert.equal((await upstream.request({url:next.bases.TELEMETRY+'e',method:'POST',body:input},origin)).status,204);
    const httpsBrowser=await chromium.launch({args:['--host-resolver-rules='+upstream.resolverRules,'--no-proxy-server']});
    try {
      const httpsPage=await httpsBrowser.newPage({ignoreHTTPSErrors:true});
      for (const revision of [oldHttps,pooled.distribution,next]) {
        const script = revision.bases.SCRIPT+'a.js';
        const response = await httpsPage.goto(script);
        assert.equal(response?.status(),200);
        assert.ok((await response!.text()).includes(revision.bases.TELEMETRY));
      }
      for (const revision of [pooled.distribution,next]) {
        const tokens=Object.values(revision.bases).map(base=>new URL(base).pathname);
        assert.equal(new Set(tokens).size,3);
        for (const token of tokens) assert.match(token,/^\/assets\/[A-Za-z0-9_-]{22}\/$/);
        assert.equal((await httpsPage.goto(revision.bases.TELEMETRY+'a.js'))?.status(),404);
      }
    } finally {
      await httpsBrowser.close();
    }
    await panel.goto(settings);
    const endpoint=panel.getByRole('listitem').filter({has:panel.getByText(pooledOrigin,{exact:true})});
    await endpoint.getByText('Operacional',{exact:true}).waitFor();
    await endpoint.getByText('LPs afetadas (2)',{exact:true}).click();
    await endpoint.getByText('One · LP · revisão '+pooled.distribution.version+' anterior',{exact:true}).waitFor();
    await endpoint.getByText('One · Sibling · revisão '+aligned.version+' atual',{exact:true}).waitFor();
    if (demo) await panel.screenshot({path:join(demo,'endpoints.png'),fullPage:true});
    await endpoint.getByRole('button',{name:'Desativar',exact:true}).click();
    await panel.getByRole('button',{name:'Confirmar',exact:true}).click();
    await endpoint.getByText('Desativado para novas revisões',{exact:true}).waitFor();
    await assert.rejects(distributionAdmin(db,{...request,action:'publish',telemetryOrigin:pooledOrigin},pooledEnv),
      {code:'TELEMETRY_ORIGIN_UNAVAILABLE'});
    assert.deepEqual(await readDistribution(db,installation,pooled.distribution.version),pooled.distribution);
    assert.equal((await upstream.request({url:pooled.distribution.bases.SCRIPT+'a.js',method:'GET',body:''})).status,200);
    const siblingState=await distributionAdmin(db,{project:'one',page:sibling,action:'inspect'},pooledEnv);
    assert.equal(siblingState.publication.ready,false);
    assert.equal(siblingState.selectedTelemetryOrigin,pooledOrigin);
    await telemetryOriginAdmin(db,{action:'set-enabled',origin:pooledOrigin,enabled:true},pooledEnv);
    assert.equal((await listTelemetryOrigins(db,pooledEnv)).items[0].state,'UNVERIFIED');
    const rollback = await distributionAdmin(db,{...request,action:'rotate',telemetryOrigin:secondary},
      {...pooledEnv,RUNTIME_COMPACT_ALIASES:'false'});
    assert.match(rollback.distribution!.bases.SCRIPT,/\/r\/v2\//);
    assert.deepEqual(await readDistribution(db,installation,next.version),next);
    assert.equal((await upstream.request({url:next.bases.SCRIPT+'a.js',method:'GET',body:''})).status,200);
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
    if(beforeCompact===undefined)delete process.env.RUNTIME_COMPACT_ALIASES;else process.env.RUNTIME_COMPACT_ALIASES=beforeCompact;
    if(beforePool===undefined)delete process.env.RUNTIME_TELEMETRY_POOL_ORIGINS;else process.env.RUNTIME_TELEMETRY_POOL_ORIGINS=beforePool;
    await ingress?.close();
    await browser.close();for(const server of [site,gateway,admin]){server.close();await once(server,'close');}
    await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
