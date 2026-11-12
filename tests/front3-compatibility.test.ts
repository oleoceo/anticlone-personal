import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {managePages} from '../apps/protected-pages.js';

async function until(check:()=>Promise<boolean>){for(let n=0;n<150;n++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error('compatibility receipt timeout');}
const quantiles=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,p50:sorted[Math.ceil(sorted.length*.50)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],p99:sorted[Math.ceil(sorted.length*.99)-1]};};

test('Front3: channel/CSP/sandbox/file/offline matrix and controlled runtime/load measurements',{timeout:180000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='front3_compat_'+randomUUID().replaceAll('-','');
 await root.query(`CREATE SCHEMA ${schema}`);const options=`-c search_path=${schema}`,db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
 const dir=await mkdtemp(join(tmpdir(),'front3-compat-'));
 let reactHtml='';
 let app:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const ra=reserve.address();assert.ok(ra&&typeof ra!=='string');const api='http://127.0.0.1:'+ra.port;await new Promise<void>(r=>reserve.close(()=>r()));
 const snippets=`<script async src="${api}/runtime.js"></script><script async src="${api}/fallback.js"></script><img src="${api}/canary/html.gif"><style>.canary{background-image:url('${api}/canary/css.gif')}</style><div class="canary">passive</div>`;
 const site=createServer(async(req,res)=>{
  if(req.url?.startsWith('/assets/')){const name=req.url.slice('/assets/'.length);if(!/^[a-zA-Z0-9_.-]+$/.test(name)){res.writeHead(404).end();return;}res.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(join(dir,'react','assets',name)));return;}
  if(req.url?.startsWith('/react')){res.writeHead(200,{'content-type':'text/html','content-security-policy':"script-src 'self' "+api+"; img-src *; style-src 'unsafe-inline'"}).end(reactHtml.replace('</body>',snippets+'</body>'));return;}
  if(req.url==='/checkout'){res.writeHead(200,{'content-type':'text/html'}).end('<h1>Native checkout</h1>');return;}
  if(req.url==='/csp')res.setHeader('Content-Security-Policy',"script-src 'none'; img-src *; style-src 'unsafe-inline'");
  res.writeHead(200,{'content-type':'text/html'}).end('<h1>Owned fixture</h1><a href="/checkout">Native checkout</a>'+ (req.url==='/baseline'?'':snippets));
 }).listen(0,'127.0.0.1');await once(site,'listening');const sa=site.address();assert.ok(sa&&typeof sa!=='string');const original='http://127.0.0.1:'+sa.port,copy='http://localhost:'+sa.port;
 const report:Record<string,unknown>={context:'Chromium local HTTP; HTTPS/Nginx separately mandatory in operational-authorization',channels:[],performance:{},no_external_delivery_or_sales_claim:true};
 try{
  for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
  await db.query("INSERT INTO projects(id,name,origin) VALUES('compat','Compatibility',$1)",[original]);
  await managePages(db,{action:'create',project:'compat',name:'Compatibility LP',url:original+'/'});
  const launch=()=>spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:options,PROJECT_ID:'compat',PORT:String(ra.port),SMTP_PORT:'1',ALLOWED_ORIGIN:original},stdio:'ignore'});
  app=launch();
  await until(async()=>{try{return(await fetch(api+'/healthz')).ok;}catch{return false;}});
  browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
  const reset=()=>db.query('DELETE FROM observations; DELETE FROM observation_source_days; DELETE FROM canary_observations; DELETE FROM alert_outbox; DELETE FROM incidents');
  const received=async()=>({observations:(await db.query('SELECT host,source FROM observations ORDER BY host,source')).rows,canaries:(await db.query('SELECT host,source FROM canary_observations ORDER BY host,source')).rows,incidents:(await db.query('SELECT host FROM incidents ORDER BY host')).rows});
  execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','tests/fixtures/react-vite','--outDir',join(dir,'react')],{stdio:'pipe'});
  reactHtml=await readFile(join(dir,'react','index.html'),'utf8');
  await reset();const react=await browser.newPage();await react.goto(copy+'/react',{waitUntil:'networkidle'});await react.getByRole('heading',{name:'React controlled SPA'}).waitFor();const reactReceipts=await received();assert.deepEqual(reactReceipts.observations.map(r=>r.source),['core','fallback']);assert.equal(reactReceipts.canaries.length,2);report.react_vite={receipts:reactReceipts,csp:true};await react.getByRole('button',{name:'SPA transition'}).click();assert.equal(react.url(),copy+'/react/next');await react.getByRole('link',{name:'Dynamic native checkout'}).click();assert.equal(react.url(),copy+'/checkout');await react.close();
  const rows=report.channels as unknown[];
  // An isolated schema and cleared observations distinguish actual receipts
  // from requested/blocked resources. No passive channel can mitigate.
  for(const [name,blocked,core,fallback,canaries,path] of [
   ['all',[],true,true,2,'/'],['bootstrap',['runtime.js'],false,true,2,'/'],
   ['core',['core.js'],false,true,2,'/'],['fallback',['fallback.js'],true,false,2,'/'],
   ['html',['canary/html.gif'],true,true,1,'/'],['css',['canary/css.gif'],true,true,1,'/'],
   ['passive-only',['runtime.js','fallback.js'],false,false,2,'/'],
   ['all-blocked',['runtime.js','fallback.js','canary/html.gif','canary/css.gif'],false,false,0,'/'],
   ['CSP',[],false,false,2,'/csp']
  ] as const){
   await db.query('DELETE FROM observations; DELETE FROM observation_source_days; DELETE FROM canary_observations; DELETE FROM alert_outbox; DELETE FROM incidents');
   const page=await browser.newPage();await page.route('**/*',route=>blocked.some(s=>route.request().url().endsWith(s))?route.abort():route.continue());
   await page.goto(copy+path,{waitUntil:'networkidle'});
   const observations=(await db.query("SELECT source FROM observations WHERE project_id='compat' ORDER BY source")).rows.map(r=>r.source);
   assert.equal(observations.includes('core'),core,name);assert.equal(observations.includes('fallback'),fallback,name);
   assert.equal((await db.query("SELECT count(*)::int n FROM canary_observations WHERE project_id='compat'")).rows[0].n,canaries,name);
   assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE project_id='compat'")).rows[0].n,core||fallback?1:0,name);
   await page.getByRole('link').click();assert.equal(page.url(),copy+'/checkout');
   rows.push({name,observations,canaries,mitigation:'NONE: observation-only policy; canaries passive',native_navigation:true});await page.close();
  }
  for(const sandbox of ['', 'allow-scripts','allow-scripts allow-same-origin']){
   await reset();
   const page=await browser.newPage();await page.goto(original+'/baseline');await page.evaluate(({url,sandbox})=>{const f=document.createElement('iframe');f.sandbox.value=sandbox;f.src=url;document.body.append(f);},{url:copy+'/',sandbox});
   await page.waitForTimeout(900);const frame=page.frames().find(f=>f.url()===copy+'/');assert.ok(frame);await frame.getByRole('link').click();await until(async()=>frame.url()===copy+'/checkout');
   const snapshot=await received();if(!sandbox.includes('allow-scripts'))assert.equal(snapshot.observations.length,0);rows.push({name:'sandbox '+sandbox,native_navigation:true,received:snapshot,mitigation:'NONE; no active policy',attribution:'host is a browser claim, not origin authentication'});await page.close();
  }
  await reset();const saved=join(dir,'saved.html');await writeFile(saved,'<h1>Saved page</h1><a href="#native">Native</a>'+snippets);const local=await browser.newPage();await local.goto(pathToFileURL(saved).href,{waitUntil:'networkidle'});await local.getByRole('link').click();assert.ok(local.url().endsWith('#native'));const fileReceipts=await received();assert.equal(fileReceipts.incidents.length,0);assert.ok(fileReceipts.canaries.every(r=>r.host===''));rows.push({name:'file',navigation:true,received:fileReceipts,attributable_host:false});await local.close();
  await reset();const offline=await browser.newContext();const offlinePage=await offline.newPage();await offlinePage.goto(copy+'/baseline');await offline.setOffline(true);await offlinePage.addScriptTag({url:api+'/runtime.js'}).catch(()=>{});await offlinePage.getByRole('link').evaluate(a=>a.setAttribute('href','#native'));await offlinePage.getByRole('link').click();assert.ok(offlinePage.url().endsWith('#native'));const offlineReceipts=await received();assert.equal(offlineReceipts.observations.length,0);rows.push({name:'offline',same_document_navigation:true,received:offlineReceipts,no_receipt_promised:true});await offline.close();
  // Interleave controls to reduce warmup/order bias. These are measurements,
  // not production budgets or a claim of zero overhead.
  const baseline:number[]=[],runtime:number[]=[],heapBaseline:number[]=[],heapRuntime:number[]=[];
  const runtimeResponseStatuses:Record<string,number>={};
  for(let n=0;n<30;n++)for(const enabled of n%2?[true,false]:[false,true]){
   const page=await browser.newPage();if(enabled)page.on('response',response=>{if(response.url().startsWith(api+'/'))runtimeResponseStatuses[String(response.status())]=(runtimeResponseStatuses[String(response.status())]??0)+1;});await page.goto(original+(enabled?'/':'/baseline'),{waitUntil:'networkidle'});
   const sample=await page.evaluate(()=>({load:performance.getEntriesByType('navigation')[0].duration,heap:(performance as Performance&{memory?:{usedJSHeapSize:number}}).memory?.usedJSHeapSize??null}));
   (enabled?runtime:baseline).push(sample.load);if(sample.heap!==null)(enabled?heapRuntime:heapBaseline).push(sample.heap);await page.close();
  }
  const latency:number[]=[];let failures=0;
  const processMemory=async()=>{if(process.platform!=='linux')return null;const status=await readFile('/proc/'+app!.pid+'/status','utf8');return {rss_kib:Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]),peak_rss_kib:Number(/VmHWM:\s+(\d+)/.exec(status)?.[1])};};
  const beforeMemory=await processMemory();
  for(let batch=0;batch<20;batch++)await Promise.all(Array.from({length:5},async()=>{const start=performance.now();try{if(!(await fetch(api+'/runtime.js')).ok)failures++;}catch{failures++;}latency.push(performance.now()-start);}));
  assert.equal(failures,0);
  const decisionLatency:number[]=[],admittedLatency:number[]=[],rejectedLatency:number[]=[];let decisionFailures=0;
  for(let batch=0;batch<20;batch++)await Promise.all(Array.from({length:5},async()=>{const start=performance.now();try{const response=await fetch(api+'/entry-decision',{method:'POST',headers:{origin:copy,'content-type':'text/plain'},body:JSON.stringify({session:randomUUID().replaceAll('-',''),signals:{}})});if(response.status===429)rejectedLatency.push(performance.now()-start);else if(response.ok&&(await response.json()).action==='OBSERVE_ONLY')admittedLatency.push(performance.now()-start);else decisionFailures++;}catch{decisionFailures++;}decisionLatency.push(performance.now()-start);}));
  assert.ok(admittedLatency.length>0);assert.ok(rejectedLatency.length>0,'bounded admission must reject the controlled burst');
  assert.equal(decisionFailures,0);const afterMemory=await processMemory();
  app.kill('SIGTERM');await once(app,'exit');app=undefined;let outageFailures=0;
  await Promise.all(Array.from({length:10},async()=>{try{await fetch(api+'/runtime.js');}catch{outageFailures++;}}));assert.equal(outageFailures,10);
  const outagePage=await browser.newPage();await outagePage.goto(copy+'/',{waitUntil:'networkidle'});await outagePage.getByRole('link').click();assert.equal(outagePage.url(),copy+'/checkout');await outagePage.close();
  app=launch();await until(async()=>{try{return(await fetch(api+'/healthz')).ok;}catch{return false;}});const recoveredPage=await browser.newPage();await recoveredPage.goto(copy+'/',{waitUntil:'networkidle'});const restarted=await received();assert.equal(restarted.observations.length,2);assert.equal(restarted.incidents.length,1);await recoveredPage.close();
  report.performance={navigation_ms:{baseline:quantiles(baseline),runtime:quantiles(runtime),p50_delta:quantiles(runtime).p50-quantiles(baseline).p50,runtime_response_statuses:runtimeResponseStatuses},heap_bytes_approximate:{baseline:quantiles(heapBaseline),runtime:quantiles(heapRuntime)},asset_load_ms:{...quantiles(latency),concurrency:5,failures},decision_load_ms:{overall:quantiles(decisionLatency),admitted:quantiles(admittedLatency),rate_limited_429:quantiles(rejectedLatency),concurrency:5,unexpected_failures:decisionFailures},gateway_process_memory:{before:beforeMemory,after:afterMemory},outage:{expected_failures:outageFailures,native_navigation:true,restart_receipts:restarted},render_gate:'fixture has no render-gate opt-in; existing entry deadline 150ms; no 0ms claim'};
  await mkdir('test-results/front3',{recursive:true});await writeFile('test-results/front3/compatibility-performance.json',JSON.stringify(report,null,2));console.log('FRONT3_REPORT '+JSON.stringify(report));
 }finally{await browser?.close();if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}await new Promise<void>(r=>site.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});}
});
