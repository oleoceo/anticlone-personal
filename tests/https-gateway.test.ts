import {distributionAdmin} from '../apps/runtime-distribution.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm,chmod,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import {request as tlsRequest} from 'node:https';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { gatewayBoundary } from '../apps/gateway-boundary.js';
import {publishPagePolicy} from '../apps/protection-admin.js';
import {managePages} from '../apps/protected-pages.js';
import {operationalAdmin} from '../apps/operational-authorization.js';
import {npmProxyFixture} from './npm-proxy-fixture.js';

function rawGet(url: string, headers: Record<string,string> = {}): Promise<{status:number; retry?:string}> {
  return new Promise((resolve,reject) => {
    const req = request(url,{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!,retry:res.headers['retry-after']}));});
    req.on('error',reject); req.end();
  });
}

test('HTTPS boundary rejects spoofed authority and applies a bounded independent client budget', async () => {
  for (const env of [{GATEWAY_TRANSPORT:'typo'}, {GATEWAY_TRANSPORT:'HTTPS_PROXY',GATEWAY_MODE:'LAB'}, {PUBLIC_GATEWAY_HOST:'gateway.test'}]) assert.throws(() => gatewayBoundary(env));
  const boundary = gatewayBoundary({GATEWAY_TRANSPORT:'HTTPS_PROXY',GATEWAY_MODE:'PILOT_OBSERVE',PUBLIC_GATEWAY_HOST:'gateway.test'});
  const server = createServer((req,res) => {if (boundary(req,res)) res.writeHead(204).end();});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {host:'gateway.test','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.1'};
  try {
    const patches: Record<string,string>[] = [{host:'evil.test'}, {'x-forwarded-proto':'http'}, {'x-forwarded-for':'192.0.2.1, 192.0.2.2'}, {forwarded:'for=192.0.2.1'}, {'x-forwarded-host':'gateway.test'}];
    for (const patch of patches) assert.equal((await rawGet(url,{...headers,...patch})).status,400);
    for (let i=0;i<120;i++) assert.equal((await rawGet(url,headers)).status,204);
    const limited = await rawGet(url,headers); assert.equal(limited.status,429); assert.equal(limited.retry,'60');
    assert.equal((await rawGet(url,{...headers,'x-forwarded-for':'192.0.2.2'})).status,204);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for(const npm of [false,true]) test(`${npm?'NPM mTLS':'HTTPS'} Nginx + PostgreSQL + Chromium: install, spoofing, limits, outage and native navigation`, {timeout:90000, skip:process.env.HTTPS_GATE_TEST !== '1' ? 'requires Linux Docker; mandatory in CI' : false}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(),'anticlone-https-'));
  const container = 'anticlone-https-' + crypto.randomUUID();
  const gatewayContainer = container + '-gateway';
  const gatewayEnv = join(tmpdir(), gatewayContainer + '.env');
  const schema = 'https_' + crypto.randomUUID().replaceAll('-','');
  const root = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await root.query(`CREATE SCHEMA ${schema}`);
  const options = `-c search_path=${schema}`;
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  if(npm){for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));}
  else for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','025_installation_signals']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  await db.query("INSERT INTO projects(id,name,origin) VALUES('https','HTTPS','https://owner.test')");
  if(!npm)await db.query(await readFile('infra/035_checkout_receipts.sql','utf8'));
  const checkoutSecret='cd'.repeat(32);
  const scopedInstallation=crypto.randomUUID();
  await db.query("INSERT INTO installations(project_id,id,origin) VALUES('https',$1,'https://owner.test')",[scopedInstallation]);
  if(!npm)for(const file of ['037_protected_pages','042_page_installation_signals','047_observed_metrics','051_runtime_distribution'])await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  else{
    const id=crypto.randomUUID();await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'https',$2,'Synthetic LP')",[id,scopedInstallation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,'https://owner.test','/')",[id]);
  }

  const scopedPage=(await db.query('SELECT id FROM protected_pages WHERE installation_id=$1',[scopedInstallation])).rows[0].id;
  const distributed=await distributionAdmin(db,{action:'publish',project:'https',page:scopedPage},{RUNTIME_PUBLIC_ORIGIN:'https://gateway.test'});assert.ok(distributed.distribution);assert.ok(distributed.snippets);
  await writeFile(gatewayEnv,Object.entries({PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'https',SMTP_PORT:'1',PORT:'3000',GATEWAY_MODE:'PILOT_OBSERVE',GATEWAY_TRANSPORT:'HTTPS_PROXY',PUBLIC_GATEWAY_HOST:'gateway.test',PILOT_ORIGINS:'["https://owner.test"]',CHECKOUT_WEBHOOK_SECRET:checkoutSecret}).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'privkey.pem'),'-out',join(dir,'fullchain.pem'),'-days','1','-subj','/CN=gateway.test','-addext','subjectAltName=DNS:gateway.test'],{stdio:'ignore'});
  if(!npm){
    execFileSync(process.execPath,['dist/apps/https-config.js',join(dir,'nginx.conf')],{env:{...process.env,PUBLIC_GATEWAY_HOST:'gateway.test'},stdio:'pipe'});
    assert.equal(await readFile(join(dir,'nginx.conf'),'utf8'),(await readFile('infra/https/nginx.conf','utf8')).replaceAll('PUBLIC_GATEWAY_HOST','gateway.test'));
    assert.notEqual(spawnSync(process.execPath,['dist/apps/https-config.js',join(dir,'nginx.conf')],{env:{...process.env,PUBLIC_GATEWAY_HOST:'gateway.test'},stdio:'pipe'}).status,0);
  }
  if(npm){
    for(const name of ['npm','monitor'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.crt'),'-days','1','-subj','/CN='+name],{stdio:'ignore'});
    await writeFile(join(dir,'client-ca.crt'),await readFile(join(dir,'npm.crt'),'utf8')+await readFile(join(dir,'monitor.crt'),'utf8'));
    const pin=(name:string)=>execFileSync('openssl',['x509','-in',join(dir,name+'.crt'),'-noout','-fingerprint','-sha256'],{encoding:'utf8'}).trim().split('=')[1];
    await writeFile(gatewayEnv,'\n'+Object.entries({GATEWAY_MODE:'OPERATIONAL',GATEWAY_TRANSPORT:'NPM_MTLS',NPM_TLS_KEY_FILE:'/run/tls/privkey.pem',NPM_TLS_CERT_FILE:'/run/tls/fullchain.pem',NPM_CLIENT_CA_FILE:'/run/tls/client-ca.crt',NPM_PROXY_FINGERPRINT:pin('npm'),NPM_MONITOR_FINGERPRINT:pin('monitor')}).map(([key,value])=>`${key}=${value}`).join('\n'),{flag:'a'});
    await writeFile(join(dir,'server-ca.crt'),await readFile(join(dir,'fullchain.pem')));
    await npmProxyFixture(dir);
    // Disposable synthetic keys shared by the non-root gateway and root Nginx fixture only.
    await chmod(dir,0o755);for(const file of await readdir(dir))await chmod(join(dir,file),0o444);
  }
  // Match production ownership and hardening: Nginx root cannot bypass DAC permissions.
  execFileSync('docker',['run','--rm','--network','none','-v',`${dir}:/files`,'--entrypoint','chown','nginx:1.28-alpine','-R','0:0','/files'],{stdio:'pipe'});
  const child = spawn('docker',['run','--rm','--name',gatewayContainer,'--network','host','--env-file',gatewayEnv,...(npm?['-v',`${dir}:/run/tls:ro`]:[]),'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','anticlone-pilot:test'],{stdio:['ignore','ignore','inherit']});
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const authority = {host:'gateway.test','x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'};
    let ready = false;
    for (let i=0;i<100&&!ready;i++) {try {ready=npm?spawnSync('docker',['exec',gatewayContainer,'node','--input-type=module','-e',`import{request}from'node:https';import{readFileSync as r}from'node:fs';const q=request({host:'127.0.0.1',port:3000,path:'/healthz',servername:'gateway.test',ca:r('/run/tls/fullchain.pem'),cert:r('/run/tls/monitor.crt'),key:r('/run/tls/monitor.key'),headers:${JSON.stringify(authority)}},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1))});q.on('error',()=>process.exit(1));q.end();`],{stdio:'ignore'}).status===0:(await rawGet('http://127.0.0.1:3000/healthz',authority)).status===200;} catch {/* startup */} if (!ready) await new Promise(r=>setTimeout(r,50));}
    assert.ok(ready);
    if(npm)await assert.rejects(fetch('http://127.0.0.1:3000/runtime.js'));else assert.equal((await fetch('http://127.0.0.1:3000/runtime.js')).status,400);
    execFileSync('docker',['run','-d','--name',container,'--network','host','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--cap-add','SETUID','--cap-add','SETGID','--cap-add','CHOWN','--security-opt','no-new-privileges:true','-v',`${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`,'-v',`${dir}:/run/tls:ro`,'nginx:1.28-alpine'],{stdio:'pipe'});
    browser = await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP gateway.test 127.0.0.1']});
    const context = await browser.newContext({ignoreHTTPSErrors:true}); // synthetic certificate only
    // The synthetic public fixture reaches loopback TLS; real public deployments do not.
    await context.grantPermissions(['local-network-access'],{origin:'https://copy.test'});
    const api = context.request;
    const resetProxyFixture=async()=>{
      // Independent scenarios must not inherit the preceding scenario's burst debt.
      // Restart only this disposable Nginx fixture; gateway/DB/budgets and all limits stay intact.
      execFileSync('docker',['restart',container],{stdio:'pipe'});
      for(let i=0;i<100;i++){try{if((await api.get('https://gateway.test/healthz')).ok())return;}catch{/* starting */}await new Promise(r=>setTimeout(r,50));}
      throw Error('synthetic proxy restart failed');
    };
    for (let i=0;i<100;i++) {try {if ((await api.get('https://gateway.test/healthz')).ok()) break;} catch {/* startup */} await new Promise(r=>setTimeout(r,50));}
    if(npm){
      const edge=async(localAddress:string,claimed:string)=>new Promise<void>((resolve,reject)=>{const req=tlsRequest({hostname:'127.0.0.1',port:443,localAddress,rejectUnauthorized:false,headers:{Host:'gateway.test','CF-Connecting-IP':claimed,'X-Forwarded-For':'203.0.113.99','X-Real-IP':'203.0.113.98',Forwarded:'for=evil'},path:'/healthz'},res=>{res.resume();res.on('end',()=>{assert.equal(res.statusCode,200);resolve();});});req.on('error',reject);req.end();});
      await edge('127.0.0.2','192.0.2.55'); // synthetic trusted Cloudflare edge
      await edge('127.0.0.1','192.0.2.66'); // DNS only: injected CF claim is ignored
      const chain=execFileSync('docker',['exec',container,'cat','/tmp/chain.log'],{encoding:'utf8'});
      assert.ok(chain.includes('192.0.2.55'));assert.ok(!chain.includes('192.0.2.66'));
    }
    // Read the synthetic CA through a root helper: private directory is root-owned.
    const caFile = join(tmpdir(), container + '.pem');
    await writeFile(caFile,execFileSync('docker',['exec',container,'cat','/run/tls/fullchain.pem']),{mode:0o600});
    try {
      const smoke = spawn(process.execPath,['dist/apps/installation-smoke.js','https://gateway.test',...(npm?['OPERATIONAL',scopedInstallation]:[])],{env:{...process.env,NODE_EXTRA_CA_CERTS:caFile},stdio:['ignore','pipe','pipe']});
      let output = ''; smoke.stderr.on('data',chunk=>{output+=chunk.toString();});
      assert.equal((await once(smoke,'exit'))[0],0,output);
    } finally {await rm(caFile,{force:true});}
    await new Promise(r=>setTimeout(r,2000));
    assert.equal((await api.get('https://gateway.test/healthz',{headers:{'X-Forwarded-For':'garbage','X-Forwarded-Proto':'http','Forwarded':'for=evil','X-Forwarded-Host':'evil'}})).status(),200);
    assert.equal((await api.get('https://gateway.test/runtime.js',{headers:{Host:'evil.test'}})).status(),421);
    assert.equal((await api.get('https://gateway.test/admin')).status(),404);
    const checkoutBody=JSON.stringify({event_id:'https_event',sale_id:'https_sale',amount_minor:100,currency:'BRL',occurred_at:'2026-11-06T00:00:00.000Z'});
    const checkoutTimestamp=String(Math.floor(Date.now()/1000));
    const checkoutHeaders={'content-type':'application/json','x-checkout-timestamp':checkoutTimestamp,'x-checkout-signature':createHmac('sha256',Buffer.from(checkoutSecret,'hex')).update(checkoutTimestamp+'.'+checkoutBody).digest('hex')};
    assert.equal((await api.post('https://gateway.test/checkout-webhook',{headers:{...checkoutHeaders,'x-checkout-signature':'00'.repeat(32)},data:checkoutBody})).status(),401);
    for(let attempt=0;attempt<2;attempt++) assert.equal((await api.post('https://gateway.test/checkout-webhook',{headers:checkoutHeaders,data:checkoutBody})).status(),200);
    assert.equal((await db.query("SELECT count(*)::int n FROM checkout_sales WHERE project_id='https'")).rows[0].n,1);
    const oversized = await api.post('https://gateway.test/observe',{headers:{origin:'https://copy.test','content-type':'text/plain'},data:'x'.repeat(2049)});
    assert.equal(oversized.status(),413);
    const page = await context.newPage();
    const diagnostics: string[] = [];
    page.on('requestfailed',req=>{if(diagnostics.length<20) diagnostics.push(`${new URL(req.url()).pathname}: ${req.failure()?.errorText}`);});
    page.on('console',msg=>{if(msg.type()==='error' && diagnostics.length<20) diagnostics.push(msg.text().slice(0,300));});
    await page.route('https://copy.test/**',route=>route.fulfill({contentType:'text/html',body:'<a href="/checkout">Native</a><script src="https://gateway.test/runtime.js"></script>'}));
    const responses = Promise.all([
      page.waitForResponse(r=>r.url()==='https://gateway.test/observe'),
      page.waitForResponse(r=>r.url()==='https://gateway.test/entry-decision'),
      page.goto('https://copy.test/')
    ]).catch(error=>{throw Error(JSON.stringify(diagnostics),{cause:error});});
    const [observation,decision] = await responses;
    assert.equal(observation.status(),204);
    assert.deepEqual(await decision.json(),{action:'OBSERVE_ONLY'});
    assert.equal((await db.query("SELECT host FROM incidents WHERE project_id='https'")).rows[0].host,'copy.test');
    await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
    await context.grantPermissions(['local-network-access'],{origin:'https://owner.test'});
    await page.route('https://owner.test/**',route=>route.fulfill({contentType:'text/html',body:'<a href="/checkout">Native</a><script src="https://gateway.test/runtime.js"></script>'}));
    const ownerObservation=page.waitForResponse(r=>r.url()==='https://gateway.test/observe');
    await page.goto('https://owner.test/'); assert.equal((await ownerObservation).status(),204);
    for (let i=0;i<100;i++) {if ((await db.query("SELECT 1 FROM installation_signals WHERE project_id='https' AND source='core'")).rowCount) break; await new Promise(r=>setTimeout(r,50));}
    assert.equal((await db.query("SELECT count(*)::int n FROM installation_signals WHERE project_id='https' AND source='core'")).rows[0].n,1);
    await new Promise(r=>setTimeout(r,3000));
    await page.route('https://owner.test/**',route=>route.fulfill({contentType:'text/html',body:`<a href="/checkout">Native scoped</a><script src="https://gateway.test/i/${scopedInstallation}/runtime.js"></script>`}));
    const scopedSession=page.waitForResponse(r=>r.url().endsWith('/observed-session'));
    const scopedDecision=page.waitForResponse(r=>r.url().includes('/i/')&&r.url().endsWith('/entry-decision'));
    await page.goto('https://owner.test/');assert.equal((await scopedSession).status(),204);assert.deepEqual(await(await scopedDecision).json(),{action:'OBSERVE_ONLY'});
    assert.equal((await db.query("SELECT count(*)::int n FROM observed_action_facts WHERE project_id='https' AND action='SESSION_OBSERVED'")).rows[0].n,1);
    await page.getByText('Native scoped',{exact:true}).click();assert.equal(new URL(page.url()).pathname,'/checkout');
    await new Promise(resolve=>setTimeout(resolve,3000));
    if(npm)await resetProxyFixture();
    await page.route('https://owner.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>'+distributed.snippets!.css+'</style><div class="anticlone-canary">Owned</div>'+distributed.snippets!.html}));
    const aliasLayers=Promise.all(['observe','observe/fallback','html.gif','css.gif'].map(path=>page.waitForResponse(response=>response.url()===distributed.distribution!.bases[path.endsWith('.gif')?'STATIC_ASSETS':'TELEMETRY']+(distributed.distribution!.paths?.[path]??path))));
    await page.goto('https://owner.test/');
    for(const response of await aliasLayers)assert.equal(response.status(),response.url().endsWith('.gif')?200:204,response.url());
    await new Promise(resolve=>setTimeout(resolve,3000));
    const wrongRole=await api.get(distributed.distribution.bases.TELEMETRY+'runtime.js');
    // NPM's generated fallback reaches the strict gateway boundary with unsanitized
    // authority/forwarding, while the direct proxy rejects the route locally.
    assert.equal(wrongRole.status(),npm?400:404);assert.equal(await wrongRole.text(),'');
    if(npm){
      await resetProxyFixture();
      // Authorize only this synthetic copy after proving the default observation state.
      const policy=await publishPagePolicy(db,'https',{enabled:true,approved_destination:'https://owner.test/approved',stealth:false,stealth_version:2,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}});
      const generation=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[scopedPage])).rows[0];
      await managePages(db,{action:'approve',project:'https',page:scopedPage,generation:generation.url_generation,configGeneration:generation.config_generation,entryVersion:policy.version,ctaVersions:[]});
      await operationalAdmin(db,{action:'authorize',project:'https',page:scopedPage,revision:0,copyOrigin:'https://copy.test',copyPathname:'/',acknowledgeUntrustedContext:true});
      await context.route('https://copy.test/**',route=>route.fulfill({contentType:'text/html',body:`<a href="/native">Native entry</a><script src="https://gateway.test/i/${scopedInstallation}/runtime.js"></script>`}));
      await context.route('https://owner.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Controlled approved destination</h1>'}));
      for(const late of [false,true]){
        const timed=await context.newPage();await timed.clock.install();await timed.clock.pauseAt(new Date());
        await timed.route('**/entry-decision',async route=>{const response=await route.fetch();assert.equal((await response.json()).action,'PAGE_REDIRECT');await timed.clock.runFor(late?151:100);await route.fulfill({response});},{times:1});
        const received=timed.waitForResponse(r=>r.url().endsWith('/entry-decision'));
        await timed.goto('https://copy.test/');await received;
        if(late){await timed.unrouteAll({behavior:'wait'});assert.equal(timed.url(),'https://copy.test/');await timed.getByText('Native entry',{exact:true}).evaluate((el:HTMLElement)=>el.click());await timed.waitForURL('https://copy.test/native');}
        else await timed.waitForURL('https://owner.test/approved');
        await timed.close();
      }
    }
    const statuses = await Promise.all(Array.from({length:35},async()=> (await api.get('https://gateway.test/runtime.js')).status()));
    assert.ok(statuses.includes(429));
    // Let the proxy burst refill, then verify an actual upstream outage.
    await new Promise(r=>setTimeout(r,1500));
    child.kill('SIGTERM'); await once(child,'exit');
    const outage = await api.get('https://gateway.test/healthz'); assert.equal(outage.status(),502);
    await page.goto('https://copy.test/'); await page.locator('a').click(); assert.equal(new URL(page.url()).pathname,'/checkout');
  } finally {
    await browser?.close();
    if (child.exitCode===null && child.signalCode===null) {child.kill('SIGTERM');await once(child,'exit');}
    try {execFileSync('docker',['rm','-f',container],{stdio:'ignore'});} catch {/* container may not have started */}
    try {execFileSync('docker',['rm','-f',gatewayContainer],{stdio:'ignore'});} catch {/* already removed on exit */}
    execFileSync('docker',['run','--rm','--network','none','-v',`${dir}:/files`,'--entrypoint','chown','nginx:1.28-alpine','-R',`${process.getuid!()}:${process.getgid!()}`,'/files'],{stdio:'pipe'});
    await rm(gatewayEnv,{force:true});
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); await rm(dir,{recursive:true,force:true});
  }
});
