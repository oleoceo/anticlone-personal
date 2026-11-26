import {notificationWorkerRole} from './notification-worker-role.js';
import assert from 'node:assert/strict';
import {createHash,randomUUID,scryptSync,X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer as httpServer,request} from 'node:http';
import {createServer as httpsServer,request as httpsRequest} from 'node:https';
import type {AddressInfo} from 'node:net';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Pool} from 'pg';
import {chromium,type Browser,type Page} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {SMTPServer} from 'smtp-server';
import {distributionAdmin} from '../apps/runtime-distribution.js';
import {copyCtaDecision} from '../apps/copy-cta-rules.js';
import {managePages} from '../apps/protected-pages.js';

async function listen(server: ReturnType<typeof httpServer> | ReturnType<typeof httpsServer>) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return (server.address() as AddressInfo).port;
}
async function close(server: ReturnType<typeof httpServer> | ReturnType<typeof httpsServer> | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
}
async function until(check:()=>Promise<boolean>, message: string) {
  const finish=Date.now()+10000;
  while (Date.now()<finish) {
    if (await check()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail(message);
}

const browserHost='gateway.test';
const hostRules='--host-resolver-rules=MAP gateway.test 127.0.0.1, MAP original.test 127.0.0.1, MAP destination-a.test 127.0.0.1, MAP destination-b.test 127.0.0.1, MAP fresh-copy.test 127.0.0.1';

test('authenticated copy rules, native CTA restoration, 150 ms browser navigation and automatic SMTP', {timeout:140000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='redirect_journey_'+randomUUID().replaceAll('-','');
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let workerRole:Awaited<ReturnType<typeof notificationWorkerRole>>|undefined;
  const dir=await mkdtemp(join(tmpdir(),'redirect-journey-'));
  const processes:ChildProcess[]=[];
  let smtp:SMTPServer|undefined;
  const deliveries:string[]=[];
  let browser:Browser|undefined, sites:ReturnType<typeof httpsServer>|undefined, proxy:ReturnType<typeof httpsServer>|undefined;
  let delays: {entry:boolean;core:boolean;error?:boolean}={entry:false,core:false};
  let logs='';
  const launch=(file:string,env:NodeJS.ProcessEnv)=>{
    const child=spawn(process.execPath,['dist/apps/'+file],{env,stdio:['ignore','ignore','pipe']});
    child.stderr!.on('data',chunk=>{if(logs.length<16384) logs+=String(chunk);});
    processes.push(child);
    return child;
  };
  try {
    for (const file of (await readdir('infra')).filter(file=>/^\d{3}_.*\.sql$/.test(file)).sort()) {
      await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    }
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=gateway.test',
      '-addext','subjectAltName=DNS:gateway.test,DNS:original.test,DNS:lp-clone-tawny.vercel.app,DNS:destination-a.test,DNS:destination-b.test,DNS:fresh-copy.test,DNS:localhost'],{stdio:'ignore'});
    const tls={key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))};
    smtp=new SMTPServer({secure:true,...tls,
      onAuth(auth,_session,done){
        if (auth.username!=='fixture-user' || auth.password!=='fixture-credential') {done(Error('fixture auth rejected'));return;}
        done(null,{user:auth.username});
      },
      onData(stream,_session,done){
        let message='';
        stream.on('data',chunk=>message+=String(chunk));
        stream.on('end',()=>{deliveries.push(message);done();});
      },
    });
    await new Promise<void>(resolve=>smtp!.listen(0,'127.0.0.1',resolve));
    const smtpPort=(smtp.server.address() as AddressInfo).port;
    const smtpEnv={SMTP_PANEL_KEY:'ab'.repeat(32),SMTP_PANEL_HOST:'localhost',SMTP_PANEL_PORT:String(smtpPort),SMTP_PANEL_TLS:'implicit'};
    const pin=createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
    const reservation=httpServer(), port=await listen(reservation);
    await close(reservation);
    let advertisedContract: string | undefined;
    proxy=httpsServer(tls,(req,res)=>{
      if (delays.error && /\/g$/.test(req.url??'')) {res.writeHead(503,{'Access-Control-Allow-Origin':'*'}).end();return;}
      const fixtureClient = /^AntiCloneFixture-([2-5])$/.exec(req.headers['user-agent']??'');
      const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,
        headers:{...req.headers,host:browserHost,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.'+(fixtureClient?.[1]??'1')}},answer=>{
        if (req.url==='/healthz' && advertisedContract) answer.headers['x-anticlone-redirect-contract']=advertisedContract;
        const relay=()=>{res.writeHead(answer.statusCode??502,answer.headers);answer.pipe(res);};
        if ((delays.entry && /\/g$/.test(req.url??'')) || (delays.core && /\/b\.js$/.test(req.url??''))) setTimeout(relay,250);
        else relay();
      });
      upstream.on('error',()=>res.writeHead(502).end());
      req.pipe(upstream);
    });
    const proxyPort=await listen(proxy);
    // Both the Admin Node process and Chromium must resolve the fixture gateway.
    const gateway='https://localhost:'+proxyPort;
    const privateEnv={...process.env,PROJECT_ID:undefined,DATABASE_URL:process.env.TEST_DATABASE_URL,
      PGOPTIONS:`-c search_path=${schema}`,SMTP_PORT:'1',NODE_EXTRA_CA_CERTS:join(dir,'cert')};
    launch('server.js',{...privateEnv,PORT:String(port),GATEWAY_MODE:'OPERATIONAL',GATEWAY_TRANSPORT:'HTTPS_PROXY',PUBLIC_GATEWAY_HOST:browserHost,GATEWAY_NOTIFICATION_DELIVERY:'off'});
    await until(()=>new Promise<boolean>(resolve=>{
      const probe=httpsRequest({hostname:'127.0.0.1',port:proxyPort,servername:browserHost,ca:tls.cert,path:'/healthz'},reply=>{
        let body='';reply.on('data',chunk=>body+=String(chunk));
        reply.on('end',()=>{
          try {resolve(JSON.parse(body).mode==='OPERATIONAL' && reply.headers['x-anticlone-redirect-contract']==='5');}
          catch {resolve(false);}
        });
      });
      probe.on('error',()=>resolve(false));probe.end();
    }),'operational gateway');
    const landingPage=await readFile('tests/fixtures/page-redirect-copy.html','utf8');
    let html='', frozenHtml='', frozenBootstrap='';
    sites=httpsServer(tls,(req,res)=>{
      if (req.url==='/local/a.js') {res.writeHead(200,{'content-type':'application/javascript'}).end(frozenBootstrap);return;}
      if (req.url?.startsWith('/assets/')) {
        if (req.url.endsWith('.js')) {res.writeHead(200,{'content-type':'application/javascript'}).end();return;}
        if (req.url.endsWith('.css')) {res.writeHead(200,{'content-type':'text/css'}).end('body { font-family: sans-serif; }');return;}
        res.writeHead(200,{'content-type':'image/svg+xml'}).end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>');
        return;
      }
      const site=req.headers.host??'';
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(site.startsWith('destination-')
        ? '<h1>Destino da homologação isolada</h1>' : req.url==='/frozen' ? frozenHtml : req.url==='/' || req.url==='/lp' ? html :
          '<h1>Destino nativo controlado</h1>');
    });
    const sitePort=await listen(sites);
    const original='https://original.test:'+sitePort, copy='https://lp-clone-tawny.vercel.app';
    const destinationA='https://destination-a.test:'+sitePort+'/oferta';
    const destinationB='https://destination-b.test:'+sitePort+'/ponto';
    const project='redirect-acceptance';
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$2,$3)',[project,'Jornada de redirecionamento',original]);
    const pageResult=await managePages(db,{project,action:'create',name:'LP de homologação',url:original+'/lp'});
    assert.ok('page' in pageResult && typeof pageResult.page==='string');
    const pageId=pageResult.page;
    const published=await distributionAdmin(db,{project,page:pageId,action:'publish'},{RUNTIME_PUBLIC_ORIGIN:gateway});
    assert.ok(published.distribution?.paths && published.snippets);
    const entry=published.distribution.bases.TELEMETRY+published.distribution.paths['entry-decision'];
    const runtime=published.distribution.bases.SCRIPT+published.distribution.paths['runtime.js'];
    html=landingPage.replace('<!-- ANTICLONE_INSTALLATION -->',published.snippets.html).replace('</body>', `
      <div data-anticlone-surface="checkout"><a href="/native-checkout" data-anticlone-point="checkout-main" target="_blank" rel="noopener">Checkout de teste</a></div>
      <script>
        setTimeout(() => {
          const button = document.createElement('a');
          button.setAttribute('data-anticlone-point','whatsapp-cta');
          button.href = '/native-whatsapp?test=1';
          button.target = '_blank';
          button.rel = 'noopener';
          button.textContent = 'WhatsApp de teste';
          document.body.append(button);
        }, 450);
      </script></body>`);
    frozenHtml=html.replace(runtime,'/local/a.js');
    frozenBootstrap=execFileSync('git',['show','87b6d30f62f7b7486f0a7b53ac3851652cd1450e:runtime/bootstrap.js'],{encoding:'utf8'})
      .replace('const distribution = null;',()=>`const distribution = ${JSON.stringify(published.distribution)};`);
    assert.match(frozenBootstrap,/core\.onload/);
    const adminReservation=httpServer(), adminPort=await listen(adminReservation);
    await close(adminReservation);
    const adminOrigin='http://127.0.0.1:'+adminPort;
    const salt='0123456789abcdef0123456789abcdef', password='synthetic-panel-password', secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    launch('admin-server.js',{...privateEnv,...smtpEnv,ADMIN_PORT:String(adminPort),RUNTIME_PUBLIC_ORIGIN:gateway,ADMIN_OPERATIONAL_GATEWAY_ORIGIN:gateway,
      ADMIN_TOTP_SECRET:secret,ADMIN_PASSWORD_RECORD:`scrypt$${salt}$${scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex')}`});
    await until(async()=>{try{return (await fetch(adminOrigin+'/admin/ui/novo/')).ok;}catch{return false;}},'authenticated panel fixture');
    browser=await chromium.launch({args:['--no-proxy-server',hostRules+', MAP lp-clone-tawny.vercel.app 127.0.0.1:'+sitePort,`--ignore-certificate-errors-spki-list=${pin}`]});
    const panelContext=await browser.newContext();
    const panel=await panelContext.newPage();
    const projectPath=adminOrigin+'/admin/ui/novo/projetos/'+project;
    const protect=projectPath+'/lps/'+pageId+'/protecao';
    await panel.goto(projectPath);
    await panel.getByLabel('Senha administrativa').fill(password);
    await panel.getByLabel('Código do autenticador').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());
    const login=panel.waitForResponse(response=>response.url().endsWith('/admin/ui/login'));
    await panel.getByRole('button',{name:'Entrar',exact:true}).click();
    assert.equal((await login).status(),204);
    await panel.goto(projectPath);
    const confirm=async(button:string,dialog:string,success:string)=>{
      await panel.getByRole('button',{name:button,exact:true}).click();
      const review=panel.getByRole('dialog',{name:dialog,exact:true});
      await review.getByRole('button',{name:'Confirmar',exact:true}).click();
      await panel.getByText(success,{exact:true}).waitFor();
    };
    const discover=await browser.newContext({userAgent:'AntiCloneFixture-2'});
    await discover.grantPermissions(['local-network-access'],{origin:copy});
    const discovery=await discover.newPage();
    await discovery.goto(copy+'/');
    await until(async()=> (await db.query('SELECT count(*)::int n FROM page_copy_contexts WHERE page_id=$1',[pageId])).rows[0].n===1,'observed copy context');
    const incident=(await db.query('SELECT id FROM incidents WHERE project_id=$1 AND host=$2',[project,'lp-clone-tawny.vercel.app'])).rows[0];
    advertisedContract='2';
    await panel.goto(projectPath+'/incidentes/'+incident.id+'/redirecionar?lp='+pageId);
    const confirmRedirect=panel.getByRole('button',{name:'CONFIRMO REDIRECIONAMENTO',exact:true});
    await panel.getByText('O gateway da instalação não atende ao contrato 3. Verifique a versão em execução no gateway.',{exact:true}).waitFor();
    assert.equal(await confirmRedirect.isDisabled(),true);
    assert.ok(await confirmRedirect.getAttribute('aria-describedby'));
    advertisedContract=undefined;
    await panel.reload();
    const selectCopy=panel.getByLabel('Página clonada');
    await selectCopy.waitFor();
    assert.equal(await selectCopy.inputValue(),copy+'/');
    const destinationField=panel.getByLabel('Redirecionar para',{exact:true});
    const saveRedirect=async(input:string, normalized:string)=>{
      await destinationField.fill(input);
      await panel.getByRole('button',{name:'CONFIRMO REDIRECIONAMENTO',exact:true}).click();
      await panel.getByText('Regra salva e habilitada.',{exact:true}).waitFor();
      assert.equal(await destinationField.inputValue(),normalized);
      assert.equal(await panel.locator('form input[type=checkbox]').filter({visible:true}).count(),0);
      assert.equal(await panel.locator('form').getByText(normalized,{exact:true}).count(),1);
      await panel.reload();
      await destinationField.waitFor();
      assert.equal(await destinationField.inputValue(),normalized);
    };
    await panel.getByLabel('Direto ou desconhecido',{exact:true}).fill('100');
    await panel.getByLabel('Orgânico',{exact:true}).fill('30');
    await saveRedirect('google.com.br','https://google.com.br/');
    assert.equal(await panel.getByLabel('Orgânico',{exact:true}).inputValue(),'30');
    await saveRedirect('google.com.br/oferta?ref=123','https://google.com.br/oferta?ref=123');
    await saveRedirect('https://exemplo.com','https://exemplo.com/');
    await panel.getByRole('button',{name:'Aplicar 100% a todas'}).click();
    await saveRedirect(destinationA.replace('https://',''),destinationA);
    await panel.getByText('Regra habilitada e elegível',{exact:true}).waitFor();
    const browserReport=async(path:string,phase:string[],visit:string|null)=>db.query(`SELECT browser_phase,elapsed_ms FROM page_copy_contexts
      WHERE page_id=$1 AND copy_pathname=$2 AND gateway_visit=browser_visit AND browser_phase=ANY($3) AND browser_visit=$4`,[pageId,path,phase,visit]);
    const scenario=async(visitor:Page,path:string,target:string,action:string,expected:boolean)=>{
      const received=visitor.waitForResponse(response=>response.url()===entry);
      const started=performance.now();
      await visitor.goto(path,{waitUntil:'commit'});
      const reply=await received;
      assert.equal(reply.status(),200);
      const visit=/ac-visit=([a-f0-9]{32})/.exec(reply.request().headers()['content-type']??'')?.[1]??null;
      if (!expected) {
        await reply.finished();
        await visitor.waitForTimeout(200);
        assert.equal((await reply.json()).action,action);
        assert.equal(visitor.url(),path);
        return {reached:false,visit};
      }
      try { await visitor.waitForURL(target,{waitUntil:'commit',timeout:1500}); }
      catch {
        assert.equal(visitor.url(),path);
        const decision=await reply.json();
        assert.equal(decision.action,action);
        const browserState=(await db.query('SELECT browser_phase,elapsed_ms,gateway_reason FROM page_copy_contexts WHERE browser_visit=$1',[visit])).rows[0];
        console.log('REDIRECT_BROWSER',JSON.stringify({path,decisionHttp:reply.request().timing().responseEnd,server:await reply.headerValue('server-timing'),browserState,final:visitor.url(),outcome:'fail-open'}));
        return {reached:false,visit};
      }
      console.log('REDIRECT_BROWSER',JSON.stringify({path,decisionHttp:reply.request().timing().responseEnd,final:visitor.url(),navigationMs:Math.round(performance.now()-started)}));
      return {reached:true,visit};
    };
    const follow=async(visitor:Page,path:string,target:string)=>{
      for (let attempt=0;attempt<3;attempt++) {
        const result=await scenario(visitor,path,target,'PAGE_REDIRECT',true);
        if (!result.reached) continue;
        const allowed=['REDIRECT_HANDOFF','PAGE_LEFT'];
        await until(async()=>!!(await browserReport(new URL(path).pathname,allowed,result.visit)).rowCount,'navigation report linked to gateway receipt');
        const elapsed=(await browserReport(new URL(path).pathname,allowed,result.visit)).rows[0].elapsed_ms;
        assert.ok(elapsed<=150,`bootstrap to location.replace took ${elapsed} ms`);
        console.log('REDIRECT_BOOTSTRAP',JSON.stringify({path,elapsed}));
        return;
      }
      assert.fail('three real browser runs remained fail-open for '+path);
    };
    const contexts=[];
    for (const mobile of [false,true]) {
      const context=await browser.newContext({userAgent:mobile?'AntiCloneFixture-4':'AntiCloneFixture-3',isMobile:mobile,hasTouch:mobile,viewport:{width:mobile?390:1440,height:850}});
      contexts.push(context);
      await context.grantPermissions(['local-network-access'],{origin:copy});
      await context.grantPermissions(['local-network-access'],{origin:original});
      const visitor=await context.newPage();
      await follow(visitor,copy+'/',destinationA);
      const owned=await context.newPage();
      await scenario(owned,original+'/lp',original+'/lp','OBSERVE_ONLY',false);
      await owned.close();
      delays={entry:true,core:false};
      const late=await scenario(visitor,copy+'/',copy+'/','PAGE_REDIRECT',false);
      await until(async()=>!!(await browserReport('/',['LATE_REDIRECT'],late.visit)).rowCount,'late browser report');
      assert.ok((await browserReport('/',['LATE_REDIRECT'],late.visit)).rows[0].elapsed_ms>=150);
      await visitor.getByText('Link nativo').click();
      await visitor.waitForURL(copy+'/#native');
      delays={entry:false,core:false};
    }
    await panel.getByRole('button',{name:'Atualizar situação',exact:true}).click();
    await panel.getByText('PAGE_REDIRECT recebido fora do prazo.',{exact:false}).waitFor();
    delays={entry:false,core:false,error:true};
    const unavailable=contexts[0].pages()[0];
    const failure=unavailable.waitForResponse(response=>response.url()===entry);
    await unavailable.goto(copy+'/');
    assert.equal((await failure).status(),503);
    await until(async()=> (await db.query("SELECT 1 FROM page_copy_contexts WHERE page_id=$1 AND copy_pathname='/' AND browser_phase='RUNTIME_ERROR'",[pageId])).rowCount===1,'browser runtime error recorded');
    assert.equal(unavailable.url(),copy+'/');
    await panel.getByRole('button',{name:'Atualizar situação',exact:true}).click();
    await panel.getByText('O runtime relatou falha',{exact:false}).waitFor();
    delays={entry:false,core:false};
    await saveRedirect(destinationB,destinationB);
    await follow(contexts[0].pages()[0],copy+'/',destinationB);
    await panel.getByRole('button',{name:'Atualizar situação',exact:true}).click();
    await panel.getByText(/PAGE_REDIRECT recebido.*navegação/).waitFor();
    await discovery.goto(copy+'/frozen');
    await until(async()=> (await db.query('SELECT count(*)::int n FROM page_copy_contexts WHERE page_id=$1',[pageId])).rows[0].n===2,'two exact copy contexts');
    await discover.close();
    await panel.goto(protect);
    await selectCopy.selectOption(copy+'/frozen');
    await panel.getByLabel('Direto ou desconhecido',{exact:true}).fill('100');
    await destinationField.fill(destinationA);
    await panel.getByRole('button',{name:'CONFIRMO REDIRECIONAMENTO',exact:true}).click();
    await panel.getByText('Regra salva e habilitada.',{exact:true}).waitFor();
    delays={entry:false,core:true};
    await scenario(contexts[0].pages()[0],copy+'/frozen',copy+'/frozen','PAGE_REDIRECT',false);
    await panel.getByRole('button',{name:'Atualizar situação',exact:true}).click();
    await panel.getByText('O pedido veio sem o marcador do runtime atual.',{exact:false}).waitFor();
    await selectCopy.selectOption(copy+'/');
    await confirm('Desativar regra','Desativar redirecionamento da cópia','Regra desativada.');
    delays={entry:false,core:false};
    await scenario(contexts[1].pages()[0],copy+'/',copy+'/','OBSERVE_ONLY',false);
    assert.equal((await db.query("SELECT count(*)::int n FROM administrative_change_audit WHERE relation_name='page_redirect_rules'")).rows[0].n,7);
    assert.ok(processes[0].pid && processes[0].exitCode===null,'edited destination was applied without restarting the gateway');

    await until(async()=> (await db.query(`SELECT 1 FROM copy_cta_inventory WHERE page_id=$1 AND copy_pathname='/' AND jsonb_array_length(points)=2`,[pageId])).rowCount===1,
      'static and dynamic CTA inventory');
    advertisedContract='4';
    await panel.goto(projectPath+'/incidentes/'+incident.id+'/substituir-cta?lp='+pageId);
    await panel.getByLabel('Página clonada').selectOption(copy+'/');
    await panel.getByLabel('checkout-main',{exact:true}).click();
    const confirmCta=panel.getByRole('button',{name:'Salvar e ativar',exact:true}).filter({visible:true});
    await panel.getByText('O gateway da instalação não atende ao contrato 5. Verifique a versão em execução no gateway.',{exact:true}).filter({visible:true}).waitFor();
    assert.equal(await confirmCta.isDisabled(),true);
    assert.ok(await confirmCta.getAttribute('aria-describedby'));
    advertisedContract=undefined;
    await panel.reload();
    await panel.getByLabel('Página clonada').selectOption(copy+'/');
    await panel.getByLabel('checkout-main',{exact:true}).click();
    const saveCta=async (label:string, destination:string, percentages:[string,string,string,string])=>{
      await panel.getByLabel('Novo destino do CTA').filter({visible:true}).fill(destination);
      for (const [index,name] of ['Tráfego pago atribuído','Orgânico','Referência','Direto ou desconhecido'].entries()) {
        await panel.getByLabel(name,{exact:true}).filter({visible:true}).fill(percentages[index]);
      }
      await panel.getByRole('button',{name:label,exact:true}).click();
      await panel.getByRole('dialog',{name:'Confirmar substituição de CTA'}).getByRole('button',{name:'Confirmo substituição de CTA'}).click();
      await panel.getByText('Regra de CTA salva e habilitada.',{exact:true}).waitFor();
    };
    await saveCta('Salvar e ativar',destinationA.replace('https://',''), ['100','0','53','100']);
    await panel.getByLabel('whatsapp-cta',{exact:true}).click();
    await saveCta('Salvar e ativar',destinationB+'?channel=whatsapp',['0','100','47','100']);
    const client=await db.connect();
    try {
      const scope={project,page:pageId,origin:copy,pathname:'/'};
      for (const [traffic,expected] of [
        ['PAID_ATTRIBUTED',['checkout-main']],['ORGANIC',['whatsapp-cta']],['DIRECT_UNKNOWN',['whatsapp-cta','checkout-main']],
      ] as const) {
        const decision=await copyCtaDecision(client,scope,'ab'.repeat(16),traffic,true);
        assert.deepEqual(decision?.mappings.map(item=>item.marker),expected);
      }
      const rules=await client.query('SELECT marker,allocation FROM copy_cta_rules WHERE project_id=$1 ORDER BY version',[project]);
      assert.deepEqual(rules.rows.map(item=>item.allocation.REFERRAL),[53,47]);
    } finally { client.release(); }
    const clickCtas=async(visitor:Page, checkout:string, whatsapp:string, active:boolean)=>{
      const received=visitor.waitForResponse(response=>response.url()===entry);
      await visitor.goto(copy+'/');
      const payload=await (await received).json();
      if (active) assert.equal(payload.action,'REPLACE_CONVERSION');
      else assert.equal(payload.action,'OBSERVE_ONLY');
      for (const [label,url] of [['Checkout de teste',checkout],['WhatsApp de teste',whatsapp]]) {
        const popup=visitor.context().waitForEvent('page');
        await visitor.getByRole('link',{name:label,exact:true}).click();
        const target=await popup;
        await target.waitForURL(url,{waitUntil:'commit'});
        assert.equal(target.url(),url);
        await target.close();
      }
      console.log('COPY_CTA',JSON.stringify({checkout,whatsapp,action:payload.action}));
    };
    await clickCtas(contexts[0].pages()[0],destinationA,destinationB+'?channel=whatsapp',true);
    await until(async()=> (await db.query(`SELECT count(DISTINCT copy_cta->>'marker')::int AS count
      FROM observed_action_facts WHERE project_id=$1 AND copy_cta->>'pathname'='/'`,[project])).rows[0].count===2,
    'browser action receipts by CTA and copy path');
    await panel.getByRole('button',{name:'Atualizar CTAs identificados'}).click();
    await panel.getByText('Execução observada no runtime',{exact:false}).first().waitFor();
    await panel.getByLabel('checkout-main',{exact:true}).click();
    await saveCta('Editar regra',destinationB,['100','0','53','100']);
    await clickCtas(contexts[1].pages()[0],destinationB,destinationB+'?channel=whatsapp',true);
    await panel.getByLabel('checkout-main',{exact:true}).click();
    await confirm('Desativar regra de CTA','Desativar regra de CTA','Regra de CTA desativada.');
    await panel.getByLabel('whatsapp-cta',{exact:true}).click();
    await confirm('Desativar regra de CTA','Desativar regra de CTA','Regra de CTA desativada.');
    await clickCtas(contexts[0].pages()[0],copy+'/native-checkout',copy+'/native-whatsapp?test=1',false);
    assert.equal((await db.query("SELECT count(*)::int n FROM administrative_change_audit WHERE relation_name='copy_cta_rules'")).rows[0].n,5);

    // Simulate a record written by the previous executable after the additive migration.
    await db.query(`INSERT INTO copy_cta_rules(project_id,page_id,copy_origin,copy_pathname,surface,marker,version,
      url_generation,config_generation,native_url,native_digest,destination,percent,enabled)
      SELECT project_id,page_id,copy_origin,copy_pathname,surface,marker,6,
        url_generation,config_generation,native_url,native_digest,destination,100,true
      FROM copy_cta_rules WHERE project_id=$1 AND version=1`,[project]);
    const legacyClient=await db.connect();
    try {
      for (const traffic of ['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN']) {
        const decision=await copyCtaDecision(legacyClient,{project,page:pageId,origin:copy,pathname:'/'},'ab'.repeat(16),traffic);
        assert.deepEqual(decision?.mappings.map(item=>[item.marker,item.destination]),[['checkout-main',destinationA]]);
      }
    } finally { legacyClient.release(); }

    // The gateway does not own the SMTP credentials or consume the outbox.
    const before=(await db.query('SELECT id,host FROM incidents WHERE project_id=$1 ORDER BY id',[project])).rows;
    assert.deepEqual(before.map(row=>row.host),['lp-clone-tawny.vercel.app']);
    await panel.goto(adminOrigin+'/admin/ui/novo/configuracoes/notificacoes');
    await panel.getByRole('combobox',{name:/^Provedor/}).selectOption('smtp');
    await panel.getByLabel('Host SMTP').fill('localhost');
    await panel.getByLabel('Porta').fill(String(smtpPort));
    await panel.getByRole('combobox',{name:/^TLS/}).selectOption('implicit');
    await panel.getByLabel('Login SMTP').fill('fixture-user');
    await panel.getByLabel('Chave SMTP').fill('fixture-credential');
    await panel.getByLabel('Remetente').fill('sender@example.test');
    await panel.getByLabel('Destinatário').fill('owner@example.test');
    await confirm('Revisar configuração SMTP','Salvar configuração SMTP','Configuração SMTP salva.');
    await confirm('Ativar alertas','Ativar novos alertas','Envio habilitado para novos eventos.');
    assert.equal(deliveries.length,0);
    workerRole=await notificationWorkerRole(db,schema,process.env.TEST_DATABASE_URL);
    const workerStatus=join(dir,'worker.json');
    const worker=launch('cta-delivery-worker.js',{...privateEnv,...smtpEnv,DATABASE_URL:workerRole.url,PROJECT_ID:project,NOTIFICATION_WORKER_MODE:'PROVIDER',NOTIFICATION_WORKER_STATUS_PATH:workerStatus});
    await until(async()=>{
      try { return JSON.parse(await readFile(workerStatus,'utf8')).state==='READY'; } catch { return false; }
    },'separate worker resolves the encrypted SMTP credential');
    assert.ok(worker.pid && worker.pid!==processes[0].pid);
    const alertContext=await browser.newContext({userAgent:'AntiCloneFixture-5'});
    const newCopy='https://fresh-copy.test:'+sitePort;
    await alertContext.grantPermissions(['local-network-access'],{origin:newCopy});
    const alertPage=await alertContext.newPage();
    await alertPage.goto(newCopy+'/lp');
    await until(async()=> (await db.query("SELECT 1 FROM incidents WHERE project_id=$1 AND host='fresh-copy.test'",[project])).rowCount===1,'new browser incident');
    await until(async()=>deliveries.length===1,'one SMTP acceptance for a new browser incident').catch(async error=>{
      const known=await db.query(`SELECT i.host,a.attempts,h.outcome FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
        LEFT JOIN clone_delivery_attempts h ON h.outbox_id=a.id WHERE i.project_id=$1 ORDER BY a.id`,[project]);
      throw new Error(String(error)+' '+JSON.stringify(known.rows),{cause:error});
    });
    await until(async()=> (await db.query(`SELECT 1 FROM clone_delivery_attempts h JOIN alert_outbox a ON a.id=h.outbox_id
      JOIN incidents i ON i.id=a.incident_id WHERE i.host='fresh-copy.test' AND a.sent_at IS NOT NULL AND h.outcome='ACCEPTED'`)).rowCount===1,'durable provider acceptance');
    await alertPage.reload();
    await alertPage.reload();
    const outbox=(await db.query(`SELECT i.host,a.attempts,h.outcome FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id
      LEFT JOIN clone_delivery_attempts h ON h.outbox_id=a.id WHERE i.project_id=$1 ORDER BY a.id`,[project])).rows;
    assert.deepEqual(outbox,[{host:'lp-clone-tawny.vercel.app',attempts:0,outcome:null},{host:'fresh-copy.test',attempts:1,outcome:'ACCEPTED'}]);
    assert.equal(deliveries.length,1);
    console.log('REDIRECT_SMTP',JSON.stringify({attempts:outbox,accepted:deliveries.length,separateWorker:true}));

  } catch(error) { throw new Error(String(error)+'\n'+logs,{cause:error}); }
  finally {
    await browser?.close();
    await close(sites);
    await close(proxy);
    for (const child of processes) if (child.exitCode===null && child.signalCode===null) {child.kill('SIGTERM');await once(child,'exit');}
    if (smtp) await new Promise<void>(resolve=>smtp!.close(()=>resolve()));
    await db.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await workerRole?.drop(root);
    await root.end();
    await rm(dir,{recursive:true,force:true});
  }
});
