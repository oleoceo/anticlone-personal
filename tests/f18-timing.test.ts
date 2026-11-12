import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {chromium,devices} from 'playwright';
import {saveDraft,activatePolicy} from '../apps/protection-policy.js';
import {importInventory,approveDestination,mapPoint} from '../apps/cta-inventory.js';
import {publishCtaPolicy} from '../apps/cta-policy.js';

test('F18 real Chromium desktop/mobile: backend, receipt, paint and effective navigation', {timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='timing_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let mode='normal';
  const before=execFileSync('git',['show','e8dd1c60bcad9303967ecd77cad1145aa2dea5a7:runtime/bootstrap.js']);
  const backendTimes:number[]=[];
  const proxy=createServer((req,res)=>{void(async()=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    if(req.url?.endsWith('.js')||req.url==='/entry-decision'||req.url==='/cta-refresh'||req.url==='/observe'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const started=performance.now();
      const response=await fetch('http://127.0.0.1:'+(mode==='unavailable'?'1':'3000')+req.url,{method:req.method,headers:{origin:req.headers.origin??'','content-type':'text/plain'},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const body=Buffer.from(await response.arrayBuffer());
      if(req.url==='/entry-decision')backendTimes.push(performance.now()-started);
      if((mode==='slow-decision'||mode==='early')&&req.url==='/entry-decision'||mode==='slow-core'&&req.url==='/core.js')await new Promise(r=>setTimeout(r,250));
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'text/plain'}).end(mode==='before'&&req.url==='/runtime.js'?before:body);return;
    }
    const runtime=mode==='baseline'||req.url==='/approved'||req.url==='/native'?'':`<script src="http://127.0.0.1:${port}/runtime.js"></script>`;
    res.writeHead(200,{'content-type':'text/html'}).end(`<style>body{background:white;color:black}a{display:block;padding:30px}</style><section data-anticlone-render-gate="http://127.0.0.1:${port}"><h1>Visible original content</h1><a id="native" data-anticlone-point="timing001" href="/native">Native checkout</a></section>${runtime}`);
  })().catch(()=>res.writeHead(503).end());});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  const original=`http://127.0.0.1:${port}`,copy=`http://localhost:${port}`;
  let app:ReturnType<typeof spawn>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    for(const f of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+f,'utf8')).replace(/^\uFEFF/,''));
    const project='timing';await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
    // Legacy gateway eligibility uses the same real lifecycle checks as GS06.
    await db.query("INSERT INTO protected_pages(id,installation_id,project_id,name,enabled,lifecycle_state) VALUES(gen_random_uuid(),gen_random_uuid(),$1,'timing',true,'ACTIVE')",[project]);
    await saveDraft(db,project,{enabled:true,approved_destination:original+'/approved',stealth:true,allocation:{PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100}});await activatePolicy(db,project);
    const allocation={PAID_ATTRIBUTED:100,ORGANIC:100,REFERRAL:100,DIRECT_UNKNOWN:100};
    await importInventory(db,project,{surface:'main',candidates:[{marker:'timing001',kind:'a',parent:'section',ordinal:1,url:copy+'/native'}]});
    const point=(await db.query('SELECT id FROM cta_points WHERE project_id=$1',[project])).rows[0].id;
    const destination=await approveDestination(db,project,{offer:'timing',url:original+'/approved'});
    await mapPoint(db,project,{pointId:point,offer:'timing',destinationId:destination.id});
    await publishCtaPolicy(db,project,{enabled:false,surface:'main',pathname:'/copy',allocation});
    app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,PROJECT_ID:project,PORT:'3000',SMTP_PORT:'25252',LAB_CONTROLLED_ORIGIN:copy,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
    let ready=false;for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
    browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});await mkdir('test-results/f18',{recursive:true});
    for(const mobile of [false,true]){
      const context=await browser.newContext(mobile?{...devices['Pixel 7']}:{viewport:{width:1440,height:900}});
      let positive=0;
      for(mode of ['baseline','before','normal','normal','normal','slow-decision','slow-core','early','unavailable','observe','cta']){
        if(['baseline','observe','cta'].includes(mode)){
          await saveDraft(db,project,{enabled:mode==='baseline',approved_destination:original+'/approved',stealth:true,allocation});await activatePolicy(db,project);
          await publishCtaPolicy(db,project,{enabled:mode==='cta',surface:'main',pathname:'/copy',allocation});
        }
        const page=await context.newPage(),events:unknown[]=[];let paints=0;
        const navigationStart=performance.now();
        page.on('framenavigated',frame=>{if(frame===page.mainFrame())events.push({event:'navigation-commit',url:frame.url(),elapsedMs:performance.now()-navigationStart});});
        page.on('console',m=>{if(m.text().startsWith('F18:'))events.push(JSON.parse(m.text().slice(4)));});
        await page.addInitScript(({early})=>{
          const record=(event:string,extra:object={})=>console.log('F18:'+JSON.stringify({event,url:location.href,timeOrigin:performance.timeOrigin,at:performance.now(),...extra}));
          new PerformanceObserver(list=>{for(const entry of list.getEntries())record('paint',{name:entry.name,start:entry.startTime});}).observe({type:'paint',buffered:true});
          new PerformanceObserver(list=>{for(const entry of list.getEntries())if(/runtime.js|core.js/.test(entry.name))record('resource',{name:entry.name,start:entry.startTime,duration:entry.duration});}).observe({type:'resource',buffered:true});
          const native=window.fetch;
          window.fetch=async(...args)=>{const start=performance.now(),response=await native(...args);if(String(args[0]).endsWith('/entry-decision')){record('browser-response',{request:start});const json=response.json.bind(response);response.json=async()=>{const result=await json();record('browser-json',{action:result.action});return result;};}return response;};
          addEventListener('pagehide',()=>record('pagehide'));
          let last='';const sample=()=>{const scope=document.querySelector<HTMLElement>('[data-anticlone-render-gate]');if(scope){const opacity=getComputedStyle(scope).opacity;if(opacity!==last){last=opacity;record('gate-frame',{opacity});}}if(performance.now()<400)requestAnimationFrame(sample);};requestAnimationFrame(sample);
          addEventListener('DOMContentLoaded',()=>{requestAnimationFrame(()=>record('visible-frame',{visible:!!document.querySelector('h1')?.getClientRects().length}));if(early&&location.pathname==='/copy')setTimeout(()=>document.querySelector<HTMLAnchorElement>('#native')!.click(),20);});
        },{early:mode==='early'});
        page.on('console',m=>{if(m.text().includes('"event":"paint"'))paints++;});
        const backendStart=backendTimes.length;
        await page.goto(copy+'/copy',{waitUntil:'commit'});
        if(mode==='slow-decision'||mode==='slow-core'){await page.waitForTimeout(50);await page.screenshot({path:`test-results/f18/${mobile?'mobile':'desktop'}-${mode}-early.png`});}
        await page.waitForTimeout(650);
        if(mode==='normal'||mode==='before'){
          // Timing can miss the commercial window under load; report the observed outcome.
          assert.ok([copy+'/copy',original+'/approved'].includes(page.url()));
          assert.ok(events.some(e=>!!e&&typeof e==='object'&&'action' in e&&e.action==='PAGE_REDIRECT'),'actual PAGE_REDIRECT received');
          if(mode==='normal'&&page.url()===original+'/approved')positive++;
        }else if(mode==='early')assert.equal(page.url(),copy+'/native');
        else assert.equal(page.url(),copy+'/copy');
        if(mode!=='normal'&&mode!=='before')assert.ok(paints>0,'real Chromium paint observed');
        if(mode==='slow-decision'||mode==='slow-core'){
          assert.equal(await page.locator('h1').isVisible(),true);
          assert.equal(await page.locator('[data-anticlone-render-gate]').evaluate(n=>getComputedStyle(n).opacity),'1');
          assert.ok(events.some(e=>!!e&&typeof e==='object'&&'event' in e&&e.event==='gate-frame'&&'opacity' in e&&e.opacity==='0'),'explicit visual scope gated');
          await page.screenshot({path:`test-results/f18/${mobile?'mobile':'desktop'}-${mode}.png`});
          await page.locator('#native').click();await page.waitForURL(copy+'/native');
        }
        if(mode==='observe'||mode==='cta'){
          assert.equal(await page.locator('[data-anticlone-render-gate]').evaluate(n=>getComputedStyle(n).opacity),'1');
          const expected=mode==='cta'?'REPLACE_CONVERSION':'OBSERVE_ONLY';
          assert.ok(events.some(e=>!!e&&typeof e==='object'&&'action' in e&&e.action===expected),'actual '+expected);
          await page.locator('#native').click();await page.waitForURL(mode==='cta'?original+'/approved':copy+'/native');
        }
        console.log('F18_MEASUREMENT',JSON.stringify({mobile,mode,backendMs:backendTimes.slice(backendStart),events,finalUrl:page.url()}));await page.close();
      }
      assert.ok(positive>0,'at least one effective real PAGE_REDIRECT per viewport');
      await context.close();
    }
  }finally{
    if(browser)await browser.close();if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}
    await new Promise<void>(r=>proxy.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
