import type {Page} from 'playwright';

const tracePrefix='SHADOW_ENTRY_TRACE ';
export async function entryProbe(page:Page){
  const events:Record<string,unknown>[]=[];
  page.on('console',message=>{if(message.text().startsWith(tracePrefix))events.push(JSON.parse(message.text().slice(tracePrefix.length)));});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())events.push({event:'navigation',url:frame.url(),nodeMono:performance.now()});});
  await page.addInitScript(prefix=>{
    const emit=(event:string,detail:Record<string,unknown>={})=>console.debug(prefix+JSON.stringify({event,mono:performance.now(),wall:Date.now(),...detail}));
    const timeout=window.setTimeout.bind(window);
    window.setTimeout=((callback:TimerHandler,ms?:number,...args:unknown[])=>{
      // Bootstrap schedules the remaining monotonic budget (e.g. 149.9ms),
      // not necessarily the literal 150. Observe its real timer without
      // changing delay, responses or the existing before/after-deadline asserts.
      const source=document.currentScript instanceof HTMLScriptElement?document.currentScript.src:'';
      if(!source.endsWith('/runtime.js')||typeof ms!=='number'||!Number.isFinite(ms)||ms<0||ms>150||typeof callback!=='function')return timeout(callback,ms,...args);
      emit('deadline-armed',{deadline:performance.now()+ms,scheduledDelay:ms});
      return timeout(()=>{emit('deadline-expired');Reflect.apply(callback,window,args);},ms);
    }) as typeof window.setTimeout;
    const fetch=window.fetch.bind(window);
    window.fetch=(...args)=>{if(String(args[0]).endsWith('/entry-decision'))emit('request');return fetch(...args);};
    const json=Response.prototype.json;
    Response.prototype.json=function(){const url=this.url;return json.call(this).then(decision=>{
      if(url.endsWith('/entry-decision'))emit('parsed',{decision,session:sessionStorage.getItem('anticlone.lab.session'),
        scripts:performance.getEntriesByType('resource').filter(e=>/\/(runtime|core)\.js$/.test(e.name)).map(e=>({url:e.name,start:e.startTime,end:e.startTime+e.duration}))});
      if(url.endsWith('/cta-refresh'))emit('cta-parsed',{decision});
      return decision;
    });};
    addEventListener('pagehide',()=>emit('pagehide'));
  },tracePrefix);
  const parsed=page.waitForEvent('console',{predicate:m=>m.text().startsWith(tracePrefix)&&JSON.parse(m.text().slice(tracePrefix.length)).event==='parsed'}).then(m=>JSON.parse(m.text().slice(tracePrefix.length)) as {decision:{action:string;destination?:string};session:string;mono:number});
  const ctaReady=async()=>{
    const ready=()=>events.some(e=>e.event==='cta-parsed'&&(e.decision as {action:string}).action==='REPLACE_CONVERSION');
    if(!ready())await page.waitForEvent('console',{predicate:()=>ready()});
  };
  return {events,parsed,ctaReady};
}
