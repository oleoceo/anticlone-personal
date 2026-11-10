import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:https';
import {createServer as createHttpServer,request,type RequestListener} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {operationalAdmin} from '../apps/operational-authorization.js';
import {publishPagePolicy} from '../apps/protection-admin.js';
import {publishCtaPolicy} from '../apps/cta-policy.js';
import {managePages} from '../apps/protected-pages.js';
import {gatewayMode} from '../apps/gateway-mode.js';
import {importInventory,approveDestination,mapPoint} from '../apps/cta-inventory.js';
import {createAdminServer} from '../apps/admin-auth.js';
import {distributionGateway} from '../apps/distribution-gateway.js';
import {observedSessionGateway} from '../apps/observed-session-gateway.js';
import type {Distribution} from '../apps/runtime-distribution.js';
import {TOTP,Secret} from 'otpauth';

test('operational v2 + MFA/CSRF admin: HTTPS publication, rotation, PAGE/CTA, suspension, isolation and fail-open',{timeout:120000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  assert.equal(gatewayMode({GATEWAY_MODE:'OPERATIONAL'},'https://owner.test').pilot,true);
  assert.throws(()=>gatewayMode({GATEWAY_MODE:'OPERATIONAL',SCOPED_LAB_RISK:'LOW'},'https://owner.test'));
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='operational_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const dir=await mkdtemp(join(tmpdir(),'operational-'));
  const saved={...process.env};
  let server:ReturnType<typeof createServer>|ReturnType<typeof createHttpServer>|undefined;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let gatewayProcess:ChildProcess|undefined;
  let admin:ReturnType<typeof createHttpServer>|undefined;
  const distributions=new Map<string,Distribution>();
  const snippets=new Map<string,string>();
  const proxy=process.env.HTTPS_GATE_TEST==='1',container='operational-'+randomUUID();
  const original='https://owner.test',copy='https://copy.test';
  const pages=[{project:'alpha',path:'/one',surface:'one'},{project:'alpha',path:'/two',surface:'two'},{project:'beta',path:'/three',surface:'three'}].map(p=>({...p,page:randomUUID(),installation:randomUUID()}));
  const allocation={PAID_ATTRIBUTED:100,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0};
  try {
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('alpha','Alpha',$1),('beta','Beta',$1)",[original]);
    for(const p of pages){
      await db.query('INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,$2,$3,$4)',[p.page,p.project,p.installation,p.surface]);
      await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[p.page,original,p.path]);
      // Use real administrative inventory/mapping operations, not SQL-created
      // mappings that bypass the administrative hostname boundary.
      await importInventory(db,p.project,{surface:p.surface,candidates:[{marker:'checkout01',kind:'a',parent:'div',ordinal:1,url:original+p.path+'-native'}]});
      const point=(await db.query('SELECT id FROM cta_points WHERE project_id=$1 AND surface=$2',[p.project,p.surface])).rows[0].id;
      const destination=await approveDestination(db,p.project,{offer:'offer',url:original+p.path+'-checkout'});
      await mapPoint(db,p.project,{pointId:point,offer:'offer',destinationId:destination.id});
      const cta=await publishCtaPolicy(db,p.project,{enabled:true,surface:p.surface,pathname:p.path,stealth:true,stealth_version:2,allocation:{...allocation,DIRECT_UNKNOWN:100}});
      const entry=await publishPagePolicy(db,p.project,{enabled:true,approved_destination:original+p.path+'-entry',stealth:false,stealth_version:2,allocation});
      await assert.rejects(operationalAdmin(db,{action:'authorize',project:p.project,page:p.page,revision:0,copyOrigin:copy,copyPathname:p.path,acknowledgeUntrustedContext:true}),/approved active page required/);
      const row=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[p.page])).rows[0];
      await managePages(db,{action:'approve',project:p.project,page:p.page,generation:row.url_generation,configGeneration:row.config_generation,entryVersion:entry.version,ctaVersions:[cta]});
    }
    // Seeding a second LP changes project configuration generations. Approve
    // the final configuration explicitly, as the administrator must do.
    for(const p of pages){
      const row=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[p.page])).rows[0];
      const entry=(await db.query('SELECT version FROM page_entry_policy_bindings WHERE page_id=$1',[p.page])).rows[0];
      const cta=(await db.query('SELECT version FROM page_cta_policy_bindings WHERE page_id=$1',[p.page])).rows[0];
      await managePages(db,{action:'approve',project:p.project,page:p.page,generation:row.url_generation,configGeneration:row.config_generation,entryVersion:entry.version,ctaVersions:[cta.version]});
    }
    process.env.GATEWAY_MODE='OPERATIONAL';
    for(const key of Object.keys(process.env))if(/^(SCOPED_LAB_|LAB_CONTROLLED_)/.test(key))delete process.env[key];
    const scripts=Object.fromEntries(await Promise.all([['runtime.js','bootstrap.js'],['core.js','core.js'],['fallback.js','fallback.js']].map(async([name,file])=>[name,await readFile('runtime/'+file)])));
    const handle=scopedGateway(db,scripts,async()=>true);
    const receipts=observedSessionGateway(db);
    const dispatch:RequestListener=(req,res)=>{if(!receipts(req,res)&&!handle(req,res))res.writeHead(404).end();};
    const distributed=distributionGateway(db,scripts,dispatch);
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=gateway.test'],{stdio:'ignore'});
    const listener:RequestListener=(req,res)=>{if(!distributed(req,res))dispatch(req,res);};
    server=(proxy ? createHttpServer(listener) : createServer({key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))},listener)).listen(0,'127.0.0.1');
    await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
    if(proxy){
      await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;
      const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,PORT:String(address.port),SMTP_PORT:'1',GATEWAY_TRANSPORT:'HTTPS_PROXY',PUBLIC_GATEWAY_HOST:'gateway.test'};
      delete (env as NodeJS.ProcessEnv).PROJECT_ID;
      let startupError='';
      gatewayProcess=spawn(process.execPath,['dist/apps/server.js'],{env,stdio:['ignore','ignore','pipe']});
      gatewayProcess.stderr!.on('data',chunk=>{startupError+=chunk.toString();});
      let ready=false;
      for(let i=0;i<100&&!ready;i++){
        try{const health=await new Promise<{mode:string;action:string}>((resolve,reject)=>{const req=request('http://127.0.0.1:'+address.port+'/healthz',{headers:{host:'gateway.test','x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'}},res=>{let data='';res.on('data',chunk=>{data+=chunk.toString();});res.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(Error('health status '+res.statusCode));}});});req.on('error',reject);req.end();});ready=health.mode==='OPERATIONAL'&&health.action==='SCOPED_AUTHORIZATION_REQUIRED';}catch{/* process startup */}
        if(!ready)await new Promise(r=>setTimeout(r,50));
      }
      assert.ok(ready,'real multiproject operational server advertises its mode: '+startupError);
      const {writeFile}=await import('node:fs/promises');
      const config=(await readFile('infra/https/nginx.conf','utf8')).replaceAll('PUBLIC_GATEWAY_HOST','gateway.test').replace('http://127.0.0.1:3000','http://127.0.0.1:'+address.port).replace('/run/tls/fullchain.pem','/run/tls/cert').replace('/run/tls/privkey.pem','/run/tls/key');
      await writeFile(join(dir,'nginx.conf'),config);
      execFileSync('docker',['run','-d','--name',container,'--network','host','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','-v',dir+':/run/tls:ro','-v',join(dir,'nginx.conf')+':/etc/nginx/nginx.conf:ro','nginx:1.28-alpine'],{stdio:'pipe'});
    }
    const base='https://gateway.test'+(proxy?'':':'+address.port);
    process.env.RUNTIME_PUBLIC_ORIGIN=base;
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',salt='0123456789abcdef0123456789abcdef';
    const passwordRecord=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    admin=createAdminServer(passwordRecord,secret,db).listen(0,'127.0.0.1');await once(admin,'listening');
    const adminAddress=admin.address();assert.ok(adminAddress&&typeof adminAddress!=='string');
    const adminBase='http://127.0.0.1:'+adminAddress.port;
    browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP gateway.test 127.0.0.1']});
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    if(proxy)assert.throws(()=>execFileSync(process.execPath,['dist/apps/installation-smoke.js',base],{env:{...process.env,NODE_EXTRA_CA_CERTS:join(dir,'cert')},stdio:'pipe'}),/unexpected gateway mode/);
    await context.grantPermissions(['local-network-access'],{origin:copy});
    await context.grantPermissions(['local-network-access'],{origin:original});
    const panel=await context.newPage();await panel.goto(adminBase+'/admin/ui/');
    await panel.locator('input[name="password"]').fill('password');
    const totp=new TOTP({secret:Secret.fromBase32(secret)});
    const validCode=totp.generate(),invalidCode=String((Number(validCode)+1)%1000000).padStart(6,'0');
    await panel.locator('input[name="code"]').fill(invalidCode);
    const badLogin=panel.waitForResponse(r=>r.url().endsWith('/admin/ui/login'));
    await panel.getByRole('button',{name:'Entrar',exact:true}).click();assert.equal((await badLogin).status(),401);
    await panel.waitForFunction(()=>document.querySelector<HTMLInputElement>('#login input[name="password"]')?.value==='');
    await panel.locator('input[name="password"]').fill('password');
    await panel.locator('input[name="code"]').fill(totp.generate());
    const goodLogin=panel.waitForResponse(r=>r.url().endsWith('/admin/ui/login'));
    await panel.getByRole('button',{name:'Entrar',exact:true}).click();assert.equal((await goodLogin).status(),204);await panel.locator('#operational-form').waitFor();
    // A session without CSRF is insufficient, even after successful MFA.
    assert.equal(await panel.evaluate(async()=> (await fetch('/admin/ui/operational',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status),403);
    const distributionForm=panel.locator('#distribution-form');
    const publication=async(p:typeof pages[number],action:string)=>{
      await distributionForm.locator('[name="project"]').fill(p.project);await distributionForm.locator('[name="page"]').fill(p.page);
      const response=panel.waitForResponse(r=>r.url().endsWith('/admin/ui/distribution'));
      await distributionForm.locator('button[value="'+action+'"]').click();const result=await response;
      assert.equal(result.status(),200);return await result.json() as {distribution:Distribution;snippets:{html:string};diagnostic:{status:string}};
    };
    for(const p of pages){
      const published=await publication(p,'publish');assert.ok(published.distribution.bases.SCRIPT.includes('/r/v2/'));
      assert.deepEqual((await publication(p,'inspect')).distribution,published.distribution);
      distributions.set(p.page,published.distribution);snippets.set(p.page,published.snippets.html);
    }
    const old=distributions.get(pages[0].page)!;
    const rotated=await publication(pages[0],'rotate');
    assert.equal(rotated.distribution.version,old.version+1);
    assert.equal(new URL(rotated.distribution.bases.SCRIPT).origin,new URL(old.bases.SCRIPT).origin);
    distributions.set(pages[0].page,rotated.distribution);snippets.set(pages[0].page,rotated.snippets.html);
    const operationalForm=panel.locator('#operational-form');
    const adminOperation=async(p:typeof pages[number],action:string,revision:number)=>{
      await operationalForm.locator('[name="project"]').fill(p.project);await operationalForm.locator('[name="page"]').fill(p.page);
      await operationalForm.locator('[name="revision"]').fill(String(revision));
      await operationalForm.locator('[name="copyOrigin"]').fill(copy);await operationalForm.locator('[name="copyPathname"]').fill(p.path);
      await operationalForm.locator('[name="acknowledge"]').check();
      const response=panel.waitForResponse(r=>r.url().endsWith('/admin/ui/operational'));
      await operationalForm.locator('button[value="'+action+'"]').click();assert.equal((await response).status(),200);
    };
    const decide=async(p:typeof pages[number],origin=copy,endpoint='cta-refresh',path=p.path)=>{
      if(proxy)await new Promise(r=>setTimeout(r,550)); // honor the real proxy budget
      const candidate=distributions.get(p.page);
      const distribution=candidate?.installation===p.installation?candidate:undefined;
      const target=distribution ? distribution.bases.TELEMETRY+distribution.paths![endpoint] : base+'/i/'+p.installation+'/'+endpoint;
      const r=await context.request.post(target,{headers:{origin,'content-type':'text/plain'},data:JSON.stringify({pathname:path,session:'a'.repeat(32),signals:{medium:'cpc'}})});return await r.json();
    };
    const authorize=(p:typeof pages[number],revision=0)=>adminOperation(p,'authorize',revision);
    for(const p of pages){
      assert.equal((await decide(p)).action,'OBSERVE_ONLY');
      await authorize(p);
      assert.equal((await decide(p)).action,'REPLACE_CONVERSION','ON retains UNCERTAIN');
      assert.equal((await decide(p,copy,'entry-decision')).action,'PAGE_REDIRECT');
      assert.equal((await decide(p,original)).action,'OBSERVE_ONLY');
      assert.equal((await decide(p,'https://unapproved.test')).action,'OBSERVE_ONLY');
      assert.equal((await decide(p,copy,'cta-refresh','/wrong')).action,'OBSERVE_ONLY');
    }
    await assert.rejects(operationalAdmin(db,{action:'authorize',project:pages[0].project,page:pages[0].page,revision:0,copyOrigin:copy,copyPathname:pages[0].path,acknowledgeUntrustedContext:true}));
    await assert.rejects(operationalAdmin(db,{action:'authorize',project:pages[0].project,page:pages[0].page,revision:1,copyOrigin:original,copyPathname:pages[0].path,acknowledgeUntrustedContext:true}),/original context forbidden/);
    await assert.rejects(operationalAdmin(db,{action:'authorize',project:'beta',page:pages[0].page,revision:1,copyOrigin:copy,copyPathname:'/one',acknowledgeUntrustedContext:true}));
    // Only owned fixture documents are fulfilled. All commercial decisions
    // below come unchanged from the real gateway via neutral v2 resources.
    await context.route(/https:\/\/(?:owner|copy)\.test\//,r=>{
      const item=pages.find(p=>new URL(r.request().url()).pathname===p.path);
      return r.fulfill({contentType:'text/html',body:item?`<a data-anticlone-surface="${item.surface}" data-anticlone-point="checkout01" href="/native">Checkout</a>${snippets.get(item.page)}`:'<a href="/native">Native</a>'});
    });
    const page=await context.newPage();
    const p=pages[0];
    const active=distributions.get(p.page)!;
    const entryUrl=active.bases.TELEMETRY+active.paths!['entry-decision'];
    const refreshUrl=active.bases.TELEMETRY+active.paths!['cta-refresh'];
    const cooldown=async()=>{if(proxy)await new Promise(r=>setTimeout(r,4500));};
    const ready=page.waitForResponse(r=>r.url()===entryUrl);
    await page.goto(copy+p.path);assert.equal((await (await ready).json()).action,'REPLACE_CONVERSION');
    await page.waitForTimeout(100);
    let clicks=0,clicking=false;page.on('request',r=>{if(clicking&&[entryUrl,refreshUrl].includes(r.url()))clicks++;});
    clicking=true;
    await page.getByRole('link').click();await page.waitForURL(original+p.path+'-checkout');assert.equal(clicks,0);
    clicking=false;await cooldown();
    const paid=await context.newPage(); // fresh declared attribution, no response rewrite
    const entered=paid.waitForResponse(r=>r.url()===entryUrl);
    await paid.goto(copy+p.path+'?utm_medium=cpc');assert.equal((await entered).status(),200);
    await paid.waitForURL(original+p.path+'-entry');await paid.close();await cooldown();
    await page.goto(original+p.path);await page.waitForTimeout(200);await page.getByRole('link').click();await page.waitForURL(original+'/native');
    await cooldown();
    assert.equal((await context.request.get(old.bases.SCRIPT+old.paths!['runtime.js'])).status(),200,'old published script remains resolvable');
    const oldDecision=async()=>{
      if(proxy)await new Promise(r=>setTimeout(r,550));
      return await (await context.request.post(old.bases.TELEMETRY+old.paths!['entry-decision'],{headers:{origin:copy,'content-type':'text/plain'},data:JSON.stringify({pathname:p.path,session:'b'.repeat(32),signals:{medium:'cpc'}})})).json();
    };
    assert.equal((await oldDecision()).action,'PAGE_REDIRECT');
    await adminOperation(p,'suspend',1);
    assert.equal((await decide(p)).action,'OBSERVE_ONLY');
    assert.equal((await oldDecision()).action,'OBSERVE_ONLY');
    assert.equal((await decide(pages[1])).action,'REPLACE_CONVERSION');
    await authorize(p,2);assert.equal((await decide(p)).action,'REPLACE_CONVERSION');
    await cooldown();
    await page.route(base+'/**',r=>r.abort());
    for(const origin of [original,copy]){
      await page.goto(origin+p.path);await page.waitForTimeout(250);assert.equal(page.url(),origin+p.path);
      await page.getByRole('link').click();await page.waitForURL(origin+'/native');
    }
    await page.unroute(base+'/**');
    await db.query("UPDATE protected_pages SET lifecycle_state='PAUSED' WHERE id=$1",[p.page]);assert.equal((await decide(p)).action,'OBSERVE_ONLY');
    await db.query("UPDATE protected_pages SET lifecycle_state='ACTIVE' WHERE id=$1",[p.page]);
    assert.equal((await decide({...p,installation:randomUUID()})).action,'OBSERVE_ONLY');
    const beta=pages[2];
    const concurrent=await Promise.allSettled([1,2].map(()=>operationalAdmin(db,{action:'authorize',project:beta.project,page:beta.page,revision:1,copyOrigin:copy,copyPathname:beta.path,acknowledgeUntrustedContext:true})));
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1,'stale concurrent approval is rejected');
    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='alpha'");assert.equal((await decide(p)).action,'OBSERVE_ONLY');assert.equal((await decide(pages[2])).action,'REPLACE_CONVERSION');
    await db.query("UPDATE projects SET lifecycle_state='ACTIVE' WHERE id='alpha'");
    await db.query('UPDATE protected_pages SET config_generation=config_generation+1 WHERE id=$1',[p.page]);assert.equal((await decide(p)).action,'OBSERVE_ONLY');
    await db.query("UPDATE cta_destinations SET url=$1 WHERE project_id='beta'",[original+'/changed']);assert.equal((await decide(beta)).action,'OBSERVE_ONLY','material destination change invalidates approval');
    assert.equal((await db.query('SELECT count(*)::int n FROM page_operational_audit')).rows[0].n,6);
    assert.deepEqual((await db.query('SELECT DISTINCT level FROM risk_assessment_days')).rows.map(r=>r.level),['UNCERTAIN']);
    // Real upstream outage, in addition to the browser network-failure case.
    await cooldown();
    if(gatewayProcess){gatewayProcess.kill('SIGTERM');await once(gatewayProcess,'exit');gatewayProcess=undefined;}
    if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}
    if(proxy)assert.equal((await context.request.get(base+'/healthz')).status(),502);
    for(const origin of [original,copy]){
      await page.goto(origin+p.path);await page.waitForTimeout(250);assert.equal(page.url(),origin+p.path);
      await page.getByRole('link').click();await page.waitForURL(origin+'/native');
    }
    await context.close();
  }finally{
    process.env=saved;if(browser)await browser.close();if(admin)await new Promise<void>(r=>admin!.close(()=>r()));if(proxy)try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}catch{/* may not have started */}if(gatewayProcess&&gatewayProcess.exitCode===null&&gatewayProcess.signalCode===null){gatewayProcess.kill('SIGTERM');await once(gatewayProcess,'exit');}if(server)await new Promise<void>(r=>server!.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});
  }
});
