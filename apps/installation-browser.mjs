// Runs only in a network-none disposable container. All browser HTTP is
// intercepted; the parent mediator independently authorizes each request.
import {chromium} from 'playwright';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
const input=createInterface({input:process.stdin});
// Even if the mediator process disappears, PID 1 terminates this disposable
// container instead of leaving Chromium running indefinitely.
setTimeout(()=>process.exit(2),22000).unref();
const pending=new Map();let sequence=0;
let initialize;
const first=new Promise(resolve=>{initialize=resolve;});
input.on('line',line=>{
  if(line.length>800000){process.exit(2);}
  const value=JSON.parse(line);
  if(initialize){const resolve=initialize;initialize=undefined;resolve(value);return;}
  const resolve=pending.get(value.id);if(resolve){pending.delete(value.id);resolve(value);}
});
const spec=await first;
const browser=await chromium.launch({chromiumSandbox:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});
const runs=[],scripts=[];let canaries={html:false,css:false};
try {
  for(const mode of ['normal','without_core','without_javascript']){
    // In the passive pass the mediator adds script-src 'none' to the document.
    // Author JavaScript is blocked while trusted CDP instrumentation remains
    // available; Chromium prohibits Debugger/Profiler with JS globally disabled.
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
    await context.route('**/*',async route=>{
      const request=route.request(),id=++sequence;
      if(sequence>64){await route.abort();return;}
      const response=await new Promise(resolve=>{
        pending.set(id,resolve);
        process.stdout.write(JSON.stringify({id,mode,url:request.url(),method:request.method(),type:request.resourceType(),body:request.postData()??''})+'\n');
      });
      if(response.blocked){await route.abort();return;}
      await route.fulfill({status:response.status,headers:response.headers,body:Buffer.from(response.body,'base64')});
    });
    // WebSockets cannot reach any network; additionally prevent their handshake.
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page=await context.newPage();
    const debuggerSession=await context.newCDPSession(page),contexts=new Map(),parsed=new Map();
    debuggerSession.on('Runtime.executionContextCreated',event=>contexts.set(event.context.id,event.context.auxData?.frameId));
    debuggerSession.on('Debugger.scriptParsed',event=>parsed.set(event.scriptId,event));
    await debuggerSession.send('Runtime.enable');await debuggerSession.send('Debugger.enable');
    await debuggerSession.send('Profiler.enable');await debuggerSession.send('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
    let loaded=false;
    try {await page.goto(spec.target,{waitUntil:'domcontentloaded',timeout:6000});await page.waitForTimeout(1200);loaded=true;}catch{/* explicit failed run */}
    if(loaded){
      const frame=(await debuggerSession.send('Page.getFrameTree')).frameTree.frame.id;
      const coverage=await debuggerSession.send('Profiler.takePreciseCoverage');
      for(const entry of coverage.result){
        const source=parsed.get(entry.scriptId);
        if(!source||contexts.get(source.executionContextId)!==frame||!spec.scriptUrls.includes(source.url)||!entry.functions.some(fn=>fn.ranges.some(range=>range.count>0)))continue;
        const text=await debuggerSession.send('Debugger.getScriptSource',{scriptId:entry.scriptId});
        scripts.push({mode,url:source.url,sha256:createHash('sha256').update(text.scriptSource).digest('hex')});
      }
      if(mode==='without_javascript'){
        const entries=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>({name:entry.name,type:entry.initiatorType})));
        canaries={html:entries.some(e=>e.name===spec.canaries.html&&e.type==='img'),css:entries.some(e=>e.name===spec.canaries.css&&e.type==='css')};
      }
    }
    runs.push({mode,loaded});
    await context.close();
  }
  process.stdout.write(JSON.stringify({done:true,runs,scripts,canaries})+'\n');
}finally{await browser.close();input.close();}
