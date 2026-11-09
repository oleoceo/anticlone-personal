import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createServer as createPortServer, type AddressInfo } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { Secret, TOTP } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';
import { importInventory } from '../apps/cta-inventory.js';
import { ctaDecision } from '../apps/cta-policy.js';
import { selected } from '../apps/allocation.js';
import { approvedDestination } from '../apps/page-redirect.js';
import { publishPagePolicy } from '../apps/protection-admin.js';

const classes=['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN'] as const;
const allocation=(n:number)=>({PAID_ATTRIBUTED:n,ORGANIC:n,REFERRAL:n,DIRECT_UNKNOWN:n});
const session=(n:number)=>n.toString(16).padStart(32,'0');
const signalsFor=(kind:typeof classes[number])=>kind==='PAID_ATTRIBUTED'?{medium:'cpc'}:kind==='ORGANIC'?{referrerHost:'google.com'}:kind==='REFERRAL'?{referrerHost:'referrer.fixture.test'}:{};

test('protection admin: real PostgreSQL/Chromium policies, classes, mappings, approved external TLS fixture and failures', {timeout:180000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='protection_ui_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`,db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  const previous=process.env.PROTECTION_APPROVED_EXTERNAL_URLS;
  let app:ReturnType<typeof spawn>|undefined;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let admin:ReturnType<typeof createAdminServer>|undefined;
  let fixture:ReturnType<typeof createServer>|undefined;
  let commercial:ReturnType<typeof createTlsServer>|undefined;
  const tlsDirectory=await mkdtemp(join(tmpdir(),'anticlone-protection-tls-'));
  try {
    for(const file of (await readdir('infra')).filter(name=>/^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0,3))<=36).sort()) await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    const portServer=createPortServer().listen(0,'127.0.0.1');await once(portServer,'listening');const gatewayPort=(portServer.address() as AddressInfo).port;await new Promise<void>(resolve=>portServer.close(()=>resolve()));
    const gateway='http://127.0.0.1:'+gatewayPort;
    let basicHref='/native-basic';
    fixture=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url?.startsWith('/clone')?'<div data-anticlone-surface="landing"><a data-anticlone-point="basic001" href="'+basicHref+'">Comprar</a><a data-anticlone-point="premium1" href="/native-premium">Comprar</a></div><script src="'+gateway+'/runtime.js"></script>':'<h1>official or native fixture</h1>')).listen(0,'127.0.0.1');
    await once(fixture,'listening');const fixturePort=(fixture.address() as AddressInfo).port;
    const original='http://127.0.0.1:'+fixturePort,clone='http://localhost:'+fixturePort,project='protection',other='other';
    const gitOpenSsl='C:/Program Files/Git/usr/bin/openssl.exe';
    const openssl=process.platform==='win32' && existsSync(gitOpenSsl)?gitOpenSsl:'openssl';
    const opensslArgs=['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(tlsDirectory,'key.pem'),'-out',join(tlsDirectory,'cert.pem'),'-days','1','-subj','/CN=checkout.fixture.test'];
    execFileSync(openssl,opensslArgs,{stdio:'ignore'});
    commercial=createTlsServer({key:await readFile(join(tlsDirectory,'key.pem')),cert:await readFile(join(tlsDirectory,'cert.pem'))},(_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<h1>Authorized synthetic commercial checkout</h1>')).listen(0,'127.0.0.1');
    await once(commercial,'listening');const external='https://checkout.fixture.test:'+(commercial.address() as AddressInfo).port+'/premium?offer=synthetic';
    process.env.PROTECTION_APPROVED_EXTERNAL_URLS=JSON.stringify({[original]:[external]});
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2),($3,$3,$4)',[project,original,other,'http://127.0.0.1:9']);
    assert.equal(approvedDestination(external,original),external);
    for(const invalid of [external+'&unapproved=1',external.replace('/premium','/another'),'https://127.0.0.1/','javascript:alert(1)','https://user:pass@checkout.fixture.test/','https://checkout.fixture.test/#fragment']) assert.throws(()=>approvedDestination(invalid,original));
    assert.throws(()=>approvedDestination(external,'http://127.0.0.1:9'));
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',salt='0123456789abcdef0123456789abcdef';
    const record=`scrypt$${salt}$${scryptSync('test password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1');await once(admin,'listening');const base='http://127.0.0.1:'+(admin.address() as AddressInfo).port;
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1, MAP checkout.fixture.test 127.0.0.1','--no-proxy-server']});
    const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
    await page.goto(base+'/admin/ui/');await page.getByLabel('Senha administrativa').fill('test password');await page.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await page.getByRole('button',{name:'Entrar',exact:true}).click();
    await page.getByLabel('Projeto de proteção').selectOption(project);await page.getByRole('button',{name:'Carregar proteção'}).click();await page.getByText('Configuração persistida carregada.',{exact:true}).waitFor();
    const cookie=(await context.cookies()).find(item=>item.name==='admin_session');assert.ok(cookie);
    const bootstrap=await fetch(base+'/admin/ui/bootstrap',{headers:{'sec-fetch-site':'same-origin',cookie:'admin_session='+cookie.value}});const {csrf}=await bootstrap.json() as {csrf:string};
    const post=(body:unknown,headers:Record<string,string>={})=>fetch(base+'/admin/ui/protection',{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json',cookie:'admin_session='+cookie.value,'x-csrf-token':csrf,...headers},body:JSON.stringify(body)});
    assert.equal((await post({project,action:'inspect',data:null},{'x-csrf-token':'invalid'})).status,403);
    assert.equal((await post({project,action:'inspect',data:null},{origin:'http://evil.test'})).status,403);
    assert.equal((await post({project,action:'inspect',data:null},{cookie:''})).status,403);
    assert.equal((await post({project:'missing',action:'inspect',data:null})).status,400);
    for(const [offer,url] of [['basic',original+'/official-basic'],['premium',external]]) {
      await page.getByLabel('Oferta do destino').fill(offer);await page.getByLabel('URL oficial aprovada').fill(url);await page.getByRole('button',{name:'Cadastrar destino aprovado'}).click();await page.getByText('Destino aprovado cadastrado.',{exact:true}).waitFor();
    }
    await importInventory(db,project,{surface:'landing',candidates:['basic001','premium1'].map((marker,i)=>({marker,kind:'a',parent:'body',ordinal:i+1,url:clone+(i?'/native-premium':'/native-basic')}))});
    await page.locator('#cta-query [name=project]').fill(project);await page.locator('#cta-query [name=surface]').fill('landing');
    for(const [marker,offer] of [['basic001','basic'],['premium1','premium']]) {
      await page.getByRole('button',{name:'Consultar CTAs',exact:true}).click();await page.locator('#cta-list label').filter({hasText:'marcador: '+marker}).locator('input').check();
      if(marker==='basic001') {
        await page.locator('#cta-query [name=project]').fill(other);assert.equal(await page.locator('#cta-select').isHidden(),true);assert.equal(await page.locator('#cta-list label').count(),0);assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_mappings')).rows[0].n,0);
        await page.locator('#cta-query [name=project]').fill(project);await page.getByRole('button',{name:'Consultar CTAs',exact:true}).click();await page.locator('#cta-list label').filter({hasText:'marcador: '+marker}).locator('input').check();
      }
      const destination=(await db.query('SELECT id FROM cta_destinations WHERE project_id=$1 AND offer=$2',[project,offer])).rows[0].id;
      await page.locator('#cta-select [name=destination]').selectOption(destination);await page.getByRole('button',{name:'Mapear CTA ao destino aprovado'}).click();await page.getByText('Mapeamento aprovado registrado. Consulte novamente; a política CTA controla sua aplicação.',{exact:true}).waitFor();
    }
    await page.getByLabel('Habilitar PAGE_REDIRECT laboratorial').check();await page.getByLabel('Destino da página').selectOption(original+'/official-basic');
    await page.getByLabel('Página PAID_ATTRIBUTED (%)').fill('0');await page.getByLabel('Página ORGANIC (%)').fill('50');await page.getByLabel('Página REFERRAL (%)').fill('100');await page.getByLabel('Página DIRECT_UNKNOWN (%)').fill('0');
    await page.getByRole('button',{name:'Publicar PAGE_REDIRECT',exact:true}).click();await page.getByText('PAGE_REDIRECT publicado. Versão 1.',{exact:true}).waitFor();
    await page.getByLabel('Habilitar REPLACE_CONVERSION laboratorial').check();await page.getByLabel('Superfície da política').fill('landing');await page.getByLabel('Caminho da página').fill('/clone');
    for(const kind of classes)await page.getByLabel('CTA '+kind+' (%)').fill('100');await page.getByRole('button',{name:'Publicar REPLACE_CONVERSION',exact:true}).click();await page.getByText('REPLACE_CONVERSION publicado. Versão 1.',{exact:true}).waitFor();
    const state=await (await post({project,action:'inspect',data:null})).json();assert.equal(state.page.allocation.PAID_ATTRIBUTED,0);assert.equal(state.cta.allocation.PAID_ATTRIBUTED,100);
    const otherState=await (await post({project:other,action:'inspect',data:null})).json();assert.equal(otherState.page,null);assert.equal(otherState.destinations.length,0);
    await db.query("INSERT INTO projects(id,name,origin) VALUES('https_project','HTTPS configuration','https://owner.test')");
    for(const [action,data] of [['destination',{offer:'official',url:'https://owner.test/approved'}],['page-publish',{enabled:true,approved_destination:'https://owner.test/approved',stealth:true,allocation:allocation(100)}],['cta-publish',{enabled:true,surface:'landing',pathname:'/clone',allocation:allocation(100)}]] as const) assert.equal((await post({project:'https_project',action,data})).status,200);
    const httpsState=await (await post({project:'https_project',action:'inspect',data:null})).json();assert.equal(httpsState.page.enabled,true);assert.equal(httpsState.cta.enabled,true);assert.equal(httpsState.destinations.length,1);
    const invalid=await post({project,action:'cta-publish',data:{enabled:true,surface:'landing',pathname:'/clone',allocation:{...allocation(100),ORGANIC:55}}});assert.equal(invalid.status,400);
    await page.reload();await page.getByLabel('Projeto de proteção').selectOption(project);await page.getByRole('button',{name:'Carregar proteção'}).click();await page.getByText('Configuração persistida carregada.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Página ORGANIC (%)').inputValue(),'50');assert.equal(await page.getByLabel('CTA ORGANIC (%)').inputValue(),'100');
    await page.getByLabel('Habilitar PAGE_REDIRECT laboratorial').uncheck();await page.getByRole('button',{name:'Publicar PAGE_REDIRECT',exact:true}).click();await page.getByText('PAGE_REDIRECT publicado. Versão 2.',{exact:true}).waitFor();
    const run=()=>spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,PORT:String(gatewayPort),SMTP_PORT:'1',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
    app=run();let ready=false;for(let i=0;i<100;i++){try{if((await fetch(gateway+'/runtime.js')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100))}assert.ok(ready);
    await page.locator('#cta-query [name=project]').fill(project);await page.locator('#cta-query [name=surface]').fill('landing');
    await page.locator('#cta-capture-url').fill(clone+'/clone');await page.locator('#cta-open-capture').click();
    await page.frameLocator('#cta-capture-frame').locator('[data-anticlone-point=basic001]').waitFor();
    const captureFrame=page.frames().find(frame=>frame.url()===clone+'/clone');assert.ok(captureFrame);
    await captureFrame.evaluate(()=>addEventListener('message',event=>{if(event.data?.type==='anticlone-inventory-request') window.name=event.data.nonce;}));
    const priorCaptures=(await db.query('SELECT count(*)::int AS n FROM cta_captures WHERE project_id=$1',[project])).rows[0].n;
    const rejectedDialog=new Promise<void>(resolve=>page.once('dialog',dialog=>{void dialog.dismiss().then(()=>resolve());}));
    await page.locator('#cta-capture-now').click();await rejectedDialog;
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_captures WHERE project_id=$1',[project])).rows[0].n,priorCaptures);
    const pendingNonce=await captureFrame.evaluate(()=>window.name);assert.match(pendingNonce,/^[a-f0-9]{32}$/);
    await page.evaluate(({origin,nonce})=>{const source=(document.querySelector('#cta-capture-frame') as HTMLIFrameElement).contentWindow;const data={type:'anticlone-inventory-result',nonce,surface:'landing',pathname:'/clone',candidates:[]};window.dispatchEvent(new MessageEvent('message',{origin,source:window,data}));window.dispatchEvent(new MessageEvent('message',{origin:'http://localhost:1',source,data}));window.dispatchEvent(new MessageEvent('message',{origin,source,data:{...data,nonce:'0'.repeat(32)}}));},{origin:clone,nonce:pendingNonce});
    await page.waitForTimeout(100);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_captures WHERE project_id=$1',[project])).rows[0].n,priorCaptures);
    assert.equal((await fetch(base+'/admin/ui/cta-import',{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json',cookie:'admin_session='+cookie.value,'x-csrf-token':csrf},body:JSON.stringify({project,surface:'landing',pathname:'/different',candidates:[]})})).status,400);
    page.on('dialog',dialog=>{void dialog.accept();});await page.locator('#cta-capture-now').click();
    await page.getByText('Captura importada. Consulte os pontos e revise antes de mapear.').waitFor();page.removeAllListeners('dialog');
    const click=async(kind:typeof classes[number],id:string,marker:string,expected:string)=>{
      const browsing=await browser!.newContext({ignoreHTTPSErrors:true});
      const signals=signalsFor(kind);
      await browsing.addInitScript(({id,signals})=>{sessionStorage.setItem('anticlone.lab.session',id);sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify(signals));},{id,signals});
      const p=await browsing.newPage();const response=p.waitForResponse(r=>r.url()===gateway+'/entry-decision');await p.goto(clone+'/clone');const decision=await (await response).json();
      // Wait for the real response continuation, then fail any decision-network call on click.
      await p.waitForTimeout(80);let networkAtClick=0;await p.route('**/entry-decision',route=>{networkAtClick++;return route.abort()});await p.route('**/cta-refresh',route=>{networkAtClick++;return route.abort()});
      await p.locator('[data-anticlone-point="'+marker+'"]').click();await p.waitForURL(expected);assert.equal(networkAtClick,0);await browsing.close();return decision;
    };
    // Real PostgreSQL policies, 0/50/100 for every declared traffic class; 50 uses both buckets.
    for(const percentage of [0,50,100]) {
      for(const kind of classes) {
        const values={...allocation(0),[kind]:percentage};
        const published=await post({project,action:'cta-publish',data:{enabled:true,surface:'landing',pathname:'/clone',allocation:values}});assert.equal(published.status,200);const {version}=await published.json() as {version:number};
        const identities=Array.from({length:200},(_,n)=>session(n));
        const chosen=identities.find(id=>selected(id,'REPLACE_CONVERSION',version,values,kind))??identities[0];
        const rejected=identities.find(id=>!selected(id,'REPLACE_CONVERSION',version,values,kind));
        for(const id of percentage===50?[chosen,rejected!]:[chosen]) {
          const active=selected(id,'REPLACE_CONVERSION',version,values,kind);
          const decision=await ctaDecision(db,project,original,clone,clone,'LOW',id,kind);assert.equal(decision.action,active?'REPLACE_CONVERSION':'OBSERVE_ONLY');
          await click(kind,id,'basic001',active?original+'/official-basic':clone+'/native-basic');
        }
      }
    }
    await click('DIRECT_UNKNOWN',session(1),'premium1',external);
    const originalPage=await browser.newPage();await originalPage.goto(original+'/clone');await originalPage.waitForTimeout(100);assert.equal(originalPage.url(),original+'/clone');await originalPage.locator('[data-anticlone-point="basic001"]').click();await originalPage.waitForURL(original+'/native-basic');await originalPage.close();
    basicHref='/changed-basic';
    await importInventory(db,project,{surface:'landing',candidates:['basic001','premium1'].map((marker,i)=>({marker,kind:'a',parent:'body',ordinal:i+1,url:clone+(i?'/native-premium':basicHref)}))});
    await click('DIRECT_UNKNOWN',session(1),'basic001',clone+'/changed-basic');await click('DIRECT_UNKNOWN',session(1),'premium1',external);
    await page.locator('#cta-query [name=project]').fill(project);await page.locator('#cta-query [name=surface]').fill('landing');
    await page.getByRole('button',{name:'Consultar CTAs',exact:true}).click();await page.getByRole('button',{name:'Reaprovar destino do CTA basic001'}).waitFor();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reaprovar destino do CTA basic001'}).click();await page.getByText('Revisão do ponto registrada. Consulte novamente.',{exact:true}).waitFor();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cta_review_audit WHERE project_id=$1',[project])).rows[0].n,1);
    await click('DIRECT_UNKNOWN',session(1),'basic001',original+'/official-basic');
    // Revoking the private exact approval preserves the local original without removing mappings.
    delete process.env.PROTECTION_APPROVED_EXTERNAL_URLS;assert.deepEqual((await ctaDecision(db,project,original,clone,clone,'LOW',session(1),'DIRECT_UNKNOWN')).mappings?.map(row=>row.marker),['basic001']);
    process.env.PROTECTION_APPROVED_EXTERNAL_URLS=JSON.stringify({[original]:[external]});
    for(const risk of ['HIGH','UNCERTAIN']) assert.equal((await ctaDecision(db,project,original,clone,clone,risk,session(1),'DIRECT_UNKNOWN')).action,'OBSERVE_ONLY');
    for(const percentage of [0,50,100]) for(const kind of classes) {
      const values={...allocation(0),[kind]:percentage};
      const {version}=await publishPagePolicy(db,project,{enabled:true,approved_destination:external,stealth:true,allocation:values});
      const identities=Array.from({length:200},(_,n)=>session(n));
      const eligible=identities.find(id=>selected(id,'PAGE_REDIRECT',version,values,kind))??identities[0];
      const ineligible=identities.find(id=>!selected(id,'PAGE_REDIRECT',version,values,kind));
      for(const id of percentage===50?[eligible,ineligible!]:[eligible]) {
        const controlled=await browser.newContext({ignoreHTTPSErrors:true});
        await controlled.addInitScript(({id,signals})=>{sessionStorage.setItem('anticlone.lab.session',id);sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify(signals));},{id,signals:signalsFor(kind)});
        const p=await controlled.newPage();await p.clock.install({time:0});await p.clock.pauseAt(1000);
        let decision:{action:string}|undefined;
        await p.route(gateway+'/entry-decision',async route=>{const response=await route.fetch();decision=await response.json();await route.fulfill({response});});
        const response=p.waitForResponse(r=>r.url()===gateway+'/entry-decision');await p.goto(clone+'/clone');await response;
        const active=selected(id,'PAGE_REDIRECT',version,values,kind);if(active)assert.equal(decision?.action,'PAGE_REDIRECT');else assert.notEqual(decision?.action,'PAGE_REDIRECT');
        if(active)await p.waitForURL(external);else {await p.waitForTimeout(100);assert.equal(p.url(),clone+'/clone')}
        await controlled.close();
      }
    }
    // Exact page publication is serialized and keeps each caller's snapshot.
    const published=await Promise.all([10,90].map(n=>publishPagePolicy(db,project,{enabled:true,approved_destination:original+'/official-basic',stealth:true,allocation:allocation(n)})));
    for(const [i,result] of published.entries())assert.equal((await db.query('SELECT allocation FROM protection_policy_versions WHERE project_id=$1 AND version=$2',[project,result.version])).rows[0].allocation.ORGANIC,[10,90][i]);
    // Configuration on an owned HTTPS project cannot enable operational mitigation.
    app.kill();await once(app,'exit');
    app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'https_project',PORT:String(gatewayPort),SMTP_PORT:'1',GATEWAY_MODE:'PILOT_OBSERVE',PILOT_ORIGINS:'["https://owner.test"]',LAB_CONTROLLED_ORIGIN:'',LAB_CONTROLLED_RISK:'',ALLOWED_ORIGIN:''},stdio:['ignore','ignore','inherit']});
    ready=false;for(let i=0;i<100;i++){try{if((await fetch(gateway+'/runtime.js')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100))}assert.ok(ready);
    for(const path of ['/entry-decision','/cta-refresh']) {const result=await fetch(gateway+path,{method:'POST',headers:{origin:'https://copy.fixture.test','content-type':'text/plain'},body:JSON.stringify({session:session(1),signals:{medium:'cpc'}})});assert.deepEqual(await result.json(),{action:'OBSERVE_ONLY'});}
  } finally {
    if(previous===undefined)delete process.env.PROTECTION_APPROVED_EXTERNAL_URLS;else process.env.PROTECTION_APPROVED_EXTERNAL_URLS=previous;
    if(app && app.exitCode===null){app.kill();await once(app,'exit')}
    await browser?.close();
    if(admin)await new Promise<void>(resolve=>admin!.close(()=>resolve()));
    if(fixture)await new Promise<void>(resolve=>fixture!.close(()=>resolve()));
    if(commercial)await new Promise<void>(resolve=>commercial!.close(()=>resolve()));
    await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
    await rm(tlsDirectory,{recursive:true,force:true});
  }
});
