import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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

test('operational authorization: synthetic HTTPS, persisted scope, no risk fixtures, original, suspension and generations',{timeout:90000},async()=>{
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
      const cta=await publishCtaPolicy(db,p.project,{enabled:true,surface:p.surface,pathname:p.path,stealth:true,stealth_version:2,allocation});
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
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=gateway.test'],{stdio:'ignore'});
    const listener:RequestListener=(req,res)=>{if(!handle(req,res))res.writeHead(404).end();};
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
    browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP gateway.test 127.0.0.1']});
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    if(proxy)assert.throws(()=>execFileSync(process.execPath,['dist/apps/installation-smoke.js',base],{env:{...process.env,NODE_EXTRA_CA_CERTS:join(dir,'cert')},stdio:'pipe'}),/unexpected gateway mode/);
    await context.grantPermissions(['local-network-access'],{origin:copy});
    const decide=async(p:typeof pages[number],origin=copy,endpoint='cta-refresh',path=p.path)=>{
      if(proxy)await new Promise(r=>setTimeout(r,550)); // honor the real proxy budget
      const r=await context.request.post(base+'/i/'+p.installation+'/'+endpoint,{headers:{origin,'content-type':'text/plain'},data:JSON.stringify({pathname:path,session:'a'.repeat(32),signals:{medium:'cpc'}})});return await r.json();
    };
    const authorize=(p:typeof pages[number],revision=0)=>operationalAdmin(db,{action:'authorize',project:p.project,page:p.page,revision,copyOrigin:copy,copyPathname:p.path,acknowledgeUntrustedContext:true});
    for(const p of pages){
      assert.equal((await decide(p)).action,'OBSERVE_ONLY');
      await authorize(p);
      assert.equal((await decide(p)).action,'REPLACE_CONVERSION','ON retains UNCERTAIN');
      assert.equal((await decide(p,copy,'entry-decision')).action,'PAGE_REDIRECT');
      assert.equal((await decide(p,original)).action,'OBSERVE_ONLY');
      assert.equal((await decide(p,'https://unapproved.test')).action,'OBSERVE_ONLY');
      assert.equal((await decide(p,copy,'cta-refresh','/wrong')).action,'OBSERVE_ONLY');
    }
    await assert.rejects(authorize(pages[0]));
    await assert.rejects(operationalAdmin(db,{action:'authorize',project:pages[0].project,page:pages[0].page,revision:1,copyOrigin:original,copyPathname:pages[0].path,acknowledgeUntrustedContext:true}),/original context forbidden/);
    await assert.rejects(operationalAdmin(db,{action:'authorize',project:'beta',page:pages[0].page,revision:1,copyOrigin:copy,copyPathname:'/one',acknowledgeUntrustedContext:true}));
    const page=await context.newPage();
    await page.route('https://owner.test/**',r=>r.fulfill({contentType:'text/html',body:'<a href="/native">Native</a>'}));
    await page.route('https://copy.test/**',r=>{
      const p=pages.find(p=>new URL(r.request().url()).pathname===p.path);
      return r.fulfill({contentType:'text/html',body:p?`<a data-anticlone-surface="${p.surface}" data-anticlone-point="checkout01" href="/native">Checkout</a><script src="${base}/i/${p.installation}/runtime.js"></script>`:'Native'});
    });
    // Exercise real prepared CTA decisions in the entry envelope, independently
    // of redirect timing. No decision payload is fabricated.
    await page.route('**/entry-decision',async r=>r.fulfill({response:await r.fetch({url:r.request().url().replace('entry-decision','cta-refresh')})}));
    const p=pages[0];
    const ready=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(copy+p.path+'?utm_medium=cpc');await ready;
    await page.waitForTimeout(100);
    let clicks=0;await page.route('**/cta-refresh',r=>{clicks++;return r.abort();});
    await page.getByRole('link').click();await page.waitForURL(original+p.path+'-checkout');assert.equal(clicks,0);
    await page.unroute('**/entry-decision');await page.unroute('**/cta-refresh');
    const entered=page.waitForResponse(r=>r.url().endsWith('/entry-decision'));
    await page.goto(copy+p.path+'?utm_medium=cpc');await entered;
    await page.waitForURL(original+p.path+'-entry');
    // A forged decision delivered on the official page must preserve native CTA.
    await page.route('https://owner.test/one',r=>r.fulfill({contentType:'text/html',body:`<a data-anticlone-surface="one" data-anticlone-point="checkout01" href="/native">Native</a><script src="${base}/i/${p.installation}/runtime.js"></script>`}));
    await page.goto(original+p.path);await page.waitForTimeout(200);await page.getByRole('link').click();await page.waitForURL(original+'/native');
    await operationalAdmin(db,{action:'suspend',project:p.project,page:p.page,revision:1});
    assert.equal((await decide(p)).action,'OBSERVE_ONLY');
    assert.equal((await decide(pages[1])).action,'REPLACE_CONVERSION');
    await authorize(p,2);assert.equal((await decide(p)).action,'REPLACE_CONVERSION');
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
    await context.close();
  }finally{
    process.env=saved;if(browser)await browser.close();if(proxy)try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}catch{/* may not have started */}if(gatewayProcess&&gatewayProcess.exitCode===null&&gatewayProcess.signalCode===null){gatewayProcess.kill('SIGTERM');await once(gatewayProcess,'exit');}if(server)await new Promise<void>(r=>server!.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});
  }
});
