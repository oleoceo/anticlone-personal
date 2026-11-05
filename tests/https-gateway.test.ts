import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { gatewayBoundary } from '../apps/gateway-boundary.js';

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

test('HTTPS Nginx + PostgreSQL + Chromium: install, spoofing, limits, outage and native navigation', {timeout:90000, skip:process.env.HTTPS_GATE_TEST !== '1' ? 'requires Linux Docker; mandatory in CI' : false}, async () => {
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
  for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','018_notification_budget','019_alert_outbox_expiry']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  await db.query("INSERT INTO projects VALUES('https','HTTPS','https://owner.test')");
  await writeFile(gatewayEnv,Object.entries({PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'https',SMTP_PORT:'1',PORT:'3000',GATEWAY_MODE:'PILOT_OBSERVE',GATEWAY_TRANSPORT:'HTTPS_PROXY',PUBLIC_GATEWAY_HOST:'gateway.test',PILOT_ORIGINS:'["https://owner.test"]'}).map(([key,value])=>`${key}=${value}`).join('\n'),{mode:0o600});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'privkey.pem'),'-out',join(dir,'fullchain.pem'),'-days','1','-subj','/CN=gateway.test','-addext','subjectAltName=DNS:gateway.test'],{stdio:'ignore'});
  execFileSync(process.execPath,['dist/apps/https-config.js',join(dir,'nginx.conf')],{env:{...process.env,PUBLIC_GATEWAY_HOST:'gateway.test'},stdio:'pipe'});
  assert.equal(await readFile(join(dir,'nginx.conf'),'utf8'),(await readFile('infra/https/nginx.conf','utf8')).replaceAll('PUBLIC_GATEWAY_HOST','gateway.test'));
  assert.notEqual(spawnSync(process.execPath,['dist/apps/https-config.js',join(dir,'nginx.conf')],{env:{...process.env,PUBLIC_GATEWAY_HOST:'gateway.test'},stdio:'pipe'}).status,0);
  // Match production ownership and hardening: Nginx root cannot bypass DAC permissions.
  execFileSync('docker',['run','--rm','--network','none','-v',`${dir}:/files`,'--entrypoint','chown','nginx:1.28-alpine','-R','0:0','/files'],{stdio:'pipe'});
  const child = spawn('docker',['run','--rm','--name',gatewayContainer,'--network','host','--env-file',gatewayEnv,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','anticlone-pilot:test'],{stdio:['ignore','ignore','inherit']});
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const authority = {host:'gateway.test','x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'};
    let ready = false;
    for (let i=0;i<100&&!ready;i++) {try {ready=(await rawGet('http://127.0.0.1:3000/healthz',authority)).status===200;} catch {/* startup */} if (!ready) await new Promise(r=>setTimeout(r,50));}
    assert.ok(ready);
    assert.equal((await fetch('http://127.0.0.1:3000/runtime.js')).status,400);
    execFileSync('docker',['run','-d','--name',container,'--network','host','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--cap-add','SETUID','--cap-add','SETGID','--cap-add','CHOWN','--security-opt','no-new-privileges:true','-v',`${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`,'-v',`${dir}:/run/tls:ro`,'nginx:1.28-alpine'],{stdio:'pipe'});
    browser = await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP gateway.test 127.0.0.1']});
    const context = await browser.newContext({ignoreHTTPSErrors:true}); // synthetic certificate only
    // The synthetic public fixture reaches loopback TLS; real public deployments do not.
    await context.grantPermissions(['local-network-access'],{origin:'https://copy.test'});
    const api = context.request;
    for (let i=0;i<100;i++) {try {if ((await api.get('https://gateway.test/healthz')).ok()) break;} catch {/* startup */} await new Promise(r=>setTimeout(r,50));}
    // Read the synthetic CA through a root helper: private directory is root-owned.
    const caFile = join(tmpdir(), container + '.pem');
    await writeFile(caFile,execFileSync('docker',['exec',container,'cat','/run/tls/fullchain.pem']),{mode:0o600});
    try {
      const smoke = spawn(process.execPath,['dist/apps/installation-smoke.js','https://gateway.test'],{env:{...process.env,NODE_EXTRA_CA_CERTS:caFile},stdio:['ignore','pipe','pipe']});
      let output = ''; smoke.stderr.on('data',chunk=>{output+=chunk.toString();});
      assert.equal((await once(smoke,'exit'))[0],0,output);
    } finally {await rm(caFile,{force:true});}
    await new Promise(r=>setTimeout(r,2000));
    assert.equal((await api.get('https://gateway.test/healthz',{headers:{'X-Forwarded-For':'garbage','X-Forwarded-Proto':'http','Forwarded':'for=evil','X-Forwarded-Host':'evil'}})).status(),200);
    assert.equal((await api.get('https://gateway.test/runtime.js',{headers:{Host:'evil.test'}})).status(),421);
    assert.equal((await api.get('https://gateway.test/admin')).status(),404);
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
