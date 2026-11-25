import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,scryptSync} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {createAdminServer} from '../apps/admin-auth.js';
import {commerceAdmin} from '../apps/commerce.js';
import {observedSessionGateway} from '../apps/observed-session-gateway.js';
import {configureEstimate} from '../apps/observed-metrics.js';
import {managePages} from '../apps/protected-pages.js';

test('Chromium delivers CTA observations across origins when the old beacon cannot be queued', {timeout:60000}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema='observed_cta_'+randomUUID().replaceAll('-','');
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await root.query('CREATE SCHEMA '+schema);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  const dir=await mkdtemp(join(tmpdir(),'observed-cta-'));
  t.after(async()=>{await db.end();await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();await rm(dir,{recursive:true,force:true});});
  for (const file of (await readdir('infra')).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort()) {
    await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
  }
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',join(dir,'key'),'-out',join(dir,'cert')],{stdio:'ignore'});
  const helper=await readFile('runtime/cta-discovery.js','utf8');
  const bootstrap=(await readFile('runtime/bootstrap.js','utf8')).replace('/* CTA_DISCOVERY */',()=>helper);
  const project='metrics-browser';
  const handle=observedSessionGateway(db);
  const {scopedGateway}=await import('../apps/scoped-gateway.js');
  let scope: ReturnType<typeof scopedGateway>;
  const accepted: {origin: string|undefined; code: number; body:string}[]=[];
  const events=new EventEmitter();
  const server=createServer({key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))},(req,res)=>{
    if (req.url?.endsWith('/observed-action')) {
      const chunks:Buffer[]=[];
      req.on('data',(chunk:Buffer)=>chunks.push(chunk));
      res.on('finish',()=>{
        const event={origin:req.headers.origin,code:res.statusCode,body:Buffer.concat(chunks).toString('utf8')};
        accepted.push(event);
        events.emit('action',event);
      });
    }
    if (req.url?.startsWith('/i/') && (handle(req,res) || scope(req,res))) return;
    const path=req.url?.split('?')[0];
    res.writeHead(200,{'Content-Type':'text/html','Referrer-Policy':'no-referrer'});
    res.end(path==='/copy' || path==='/copy-two' ? html : '<h1>Destino controlado</h1>');
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const port=(server.address() as AddressInfo).port;
  const copy='https://localhost:'+port;
  const gateway='https://127.0.0.1:'+port;
  const original='https://original.test';
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
  const lp=await managePages(db,{project,action:'create',name:'Oferta',url:original+'/'});
  assert.ok('page' in lp && typeof lp.page==='string');
  const pageId=lp.page;
  const other=await managePages(db,{project,action:'create',name:'Outra LP',url:original+'/two'});
  assert.ok('page' in other && typeof other.page==='string');
  const published=await (await import('../apps/runtime-distribution.js')).distributionAdmin(db,
    {project,page:pageId,action:'publish'},{RUNTIME_PUBLIC_ORIGIN:'https://gateway.test'});
  assert.ok(published.distribution);
  const installation:string=(await db.query('SELECT installation_id FROM protected_pages WHERE id=$1',[pageId])).rows[0].installation_id;
  const endpoint=gateway+'/i/'+installation+'/';
  const html='<a id="basic" data-anticlone-point="basic001" href="/checkout-basic">Básico</a> '+
    '<section data-anticlone-surface="main"><button id="complete" type="button" data-anticlone-point="complete1" onclick="window.location=\'/checkout-complete\'">Completo</button></section>'+
    '<script src="'+endpoint+'runtime.js"></script>';
  const previousMode=process.env.GATEWAY_MODE;
  process.env.GATEWAY_MODE='OPERATIONAL';
  try {
    scope=scopedGateway(db,{'runtime.js':Buffer.from(bootstrap),'core.js':Buffer.from('')},async()=>true);
  } finally {
    if(previousMode===undefined)delete process.env.GATEWAY_MODE;
    else process.env.GATEWAY_MODE=previousMode;
  }
  await db.query('INSERT INTO page_copy_contexts(project_id,page_id,copy_origin,copy_pathname) VALUES($1,$2,$3,\'/copy\'),($1,$2,$3,\'/copy-two\')',[project,pageId,copy]);
  const browser=await chromium.launch({channel:'chromium',ignoreDefaultArgs:['--disable-back-forward-cache'],
    args:['--no-proxy-server','--host-resolver-rules=MAP localhost 127.0.0.1']});
  t.after(()=>browser.close());
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  const page=await context.newPage();
  const report=async(extra:object={})=>await commerceAdmin(db,{action:'report',activity:true,project,
    from:new Date(Date.now()-60000).toISOString(),until:new Date(Date.now()+60000).toISOString(),...extra}) as {
      click_sessions:number; observations:{action:string;events:number;traffic_class:string}[];
      cta_points:{alias:string;clicks:number;sessions:number}[];
      estimate_projects:{clicks:number;numerator:string}[];
    };
  const installRule=async(version:number, marker:string, surface:string, native:string, name:string, kind='a', allocation?:object)=>{
    await db.query(`INSERT INTO copy_cta_rules(project_id,page_id,copy_origin,copy_pathname,surface,marker,version,
      url_generation,config_generation,native_url,native_digest,destination,percent,enabled,display_name,activation_kind,allocation)
      SELECT $1,id,$3,'/copy',$4,$5,$6,url_generation,config_generation,$7,$8,$9,100,true,$10,$11,$12
      FROM protected_pages WHERE project_id=$1 AND id=$2`,
    [project,pageId,copy,surface,marker,version,copy+native,createHash('sha256').update(copy+native).digest('hex'),gateway+'/target-'+version,name,kind,allocation ?? null]);
  };
  await installRule(1,'basic001','','/checkout-basic','Básico');
  await installRule(2,'complete1','main','/checkout-complete','Completo','button');
  await configureEstimate(db,project,10000,500,'BRL');
  // Simulate a browser refusing to enqueue the old beacon. Keepalive must
  // still deliver the observed action, without a click-time decision request.
  await context.addInitScript(() => {
    const sendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url,data) => String(url).endsWith('/observed-action') ? false : sendBeacon(url,data);
  });
  const go=async(url:string)=>{
    const decision=page.waitForResponse(r=>r.url()===endpoint+'entry-decision');
    await page.goto(url);
    const value=await (await decision).json();
    assert.equal(typeof value.observationReceipt,'string');
  };
  const click=async(id:string,version:number)=>{
    await page.waitForFunction(expected=>{
      const anchor=document.querySelector<HTMLAnchorElement>('#basic')!;
      if (!anchor) return false;
      let target='';
      window.addEventListener('click',e=>{target=anchor.href;e.preventDefault();},{once:true});
      anchor.click();
      return target===expected;
    },gateway+'/target-1',{timeout:5000});
    const [[response]]=await Promise.all([
      once(events,'action',{signal:AbortSignal.timeout(7000)}),
      page.waitForURL(gateway+'/target-'+version,{timeout:5000}),
      page.locator(id).click(),
    ]);
    assert.equal(response.code,204);
    return response.body as string;
  };
  await go(copy+'/copy');
  assert.equal((await report()).click_sessions,0);
  const event=await click('#basic',1);
  const back=page.waitForResponse(r=>r.url()===endpoint+'cta-refresh'||r.url()===endpoint+'entry-decision');
  await page.goBack({waitUntil:'commit'});assert.equal(typeof (await (await back).json()).observationReceipt,'string');
  await click('#complete',2);
  const returnAgain=page.waitForResponse(r=>r.url()===endpoint+'cta-refresh'||r.url()===endpoint+'entry-decision');
  await page.goBack({waitUntil:'commit'});assert.equal(typeof (await (await returnAgain).json()).observationReceipt,'string');
  const refreshed=page.waitForResponse(r=>r.url()===endpoint+'entry-decision');
  await page.reload();await refreshed;
  await click('#basic',1);
  const replay=await fetchLocal(endpoint+'observed-action',event,copy);
  assert.equal(replay,204);
  assert.deepEqual(accepted.map(row=>row.code),[204,204,204,204]);
  assert.ok(accepted.every(row=>row.origin===copy));
  const metrics=await report({page:pageId,copyOrigin:copy,copyPath:'/copy'});
  assert.equal(metrics.click_sessions,1);
  assert.equal(metrics.observations.filter(row=>row.action==='SESSION_OBSERVED').reduce((n,row)=>n+row.events,0),1);
  assert.deepEqual(metrics.cta_points.map(row=>[row.alias,row.clicks,row.sessions]),[['Básico',2,1],['Completo',1,1]]);
  assert.deepEqual(metrics.estimate_projects.map(row=>[row.clicks,row.numerator]),[[3,'15000000']]);
  assert.equal((await report({page:pageId,copyOrigin:copy,copyPath:'/copy-two'})).click_sessions,0);
  assert.equal((await report({page:other.page})).click_sessions,0);
  assert.equal((await report({project:'other-project',page:pageId})).click_sessions,0);
  const browserClass=async(path:string, referrer?:string)=>{
    const visitor=await browser.newContext({ignoreHTTPSErrors:true});
    try {
      const tab=await visitor.newPage();
      const expected=tab.waitForResponse(r=>r.url()===endpoint+'entry-decision');
      await tab.goto(copy+path,{referer:referrer});
      const entry=await (await expected).json();
      const receipt=(await db.query('SELECT traffic_class FROM observed_decision_receipts WHERE id=$1',
        [entry.observationReceipt ?? null])).rows[0];
      return {entry,traffic:receipt?.traffic_class};
    } finally {await visitor.close();}
  };
  for (const paid of ['utm_medium=cpc','gclid=test','fbclid=test']) {
    assert.equal((await browserClass('/copy?'+paid)).traffic,'PAID_ATTRIBUTED');
  }
  assert.equal((await browserClass('/copy','https://www.google.com/')).traffic,'ORGANIC');
  assert.equal((await browserClass('/copy','https://referrer.test/')).traffic,'REFERRAL');
  assert.equal((await browserClass('/copy')).traffic,'DIRECT_UNKNOWN');
  await go(copy+'/copy?utm_medium=cpc');
  const initial=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('anticlone.lab.attribution')!));
  assert.deepEqual(initial,{});
  const directAllocation={DIRECT_UNKNOWN:100,PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0};
  await installRule(3,'basic001','','/checkout-basic','Básico','a',directAllocation);
  await installRule(4,'complete1','main','/checkout-complete','Completo','button',directAllocation);
  assert.equal((await browserClass('/copy?utm_medium=cpc')).entry.action,'OBSERVE_ONLY');
  assert.equal((await browserClass('/copy')).entry.mappings.length,2);

  const salt=Buffer.alloc(16,43), password='test-panel-password', secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const record='scrypt$'+salt.toString('hex')+'$'+scryptSync(password,salt,64).toString('hex');
  const admin=createAdminServer(record,secret,db).listen(0,'127.0.0.1');
  await once(admin,'listening');
  t.after(()=>{admin.closeAllConnections();admin.close();});
  const panel=await browser.newPage();
  const dashboard='http://127.0.0.1:'+(admin.address() as AddressInfo).port+'/admin/ui/novo/visao-geral';
  await panel.goto(dashboard);
  await panel.getByLabel('Senha administrativa').fill(password);
  await panel.getByLabel('Código do autenticador').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());
  await panel.getByRole('button',{name:'Entrar',exact:true}).click();
  await panel.getByRole('combobox',{name:'Projeto',exact:true}).selectOption(project);
  await panel.getByRole('combobox',{name:'LP',exact:true}).selectOption(pageId);
  await panel.getByRole('combobox',{name:'Cópia',exact:true}).selectOption(JSON.stringify([copy,'/copy']));
  const points=panel.getByRole('region',{name:'Cliques por CTA'});
  await points.getByRole('rowheader',{name:'Básico'}).waitFor();
  await points.getByRole('rowheader',{name:'Completo'}).waitFor();
  const kpi=(label:string)=>panel.locator('.overview-metrics').getByText(label,{exact:true}).locator('..').locator('dd').first();
  assert.equal(await kpi('Cliques nos CTAs').innerText(),'3');
  assert.equal(await kpi('Sessões com clique').innerText(),'1');
  assert.equal(await kpi('Valor estimado recuperado').innerText(),'R$ 15,00');
  await panel.getByRole('link',{name:'Configurar estimativa',exact:true}).click();
  await panel.getByLabel('Ticket médio',{exact:true}).fill('200');
  await panel.getByLabel('Conversão estimada (%)').fill('10');
  await panel.getByRole('button',{name:'Revisar e salvar',exact:true}).click();
  await panel.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
  await panel.getByText(/Estimativa configurada. Versão 2/).waitFor();
  await panel.reload();
  await panel.getByRole('region',{name:'Resultado da estimativa'}).getByText('R$ 60,00',{exact:true}).waitFor();

});

async function fetchLocal(url:string, data:string, origin:string):Promise<number|undefined> {
  const {request}=await import('node:https');
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'POST',rejectUnauthorized:false,headers:{origin,'content-type':'text/plain'}},res=>{
      res.resume();resolve(res.statusCode);
    });
    req.on('error',reject);req.end(data);
  });
}
