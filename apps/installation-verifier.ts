import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {resolve} from 'node:path';
import {publicAddress} from './infrastructure-dns.js';
import type {Distribution} from './runtime-distribution.js';

export type VerificationRequest={url:string;method:'GET'|'POST';body:string};
export type VerificationResponse={status:number;headers:Record<string,string>;body:Buffer};
export type VerificationSpec={target:string;distribution:Distribution};
export type ControlledCheck={status:'FULL'|'PARTIAL'|'UNSUPPORTED'|'NOT_VERIFIED';checkedAt:string;scope:'CONTROLLED_BROWSER_CURRENT_LOAD';reason:string;layers:Record<string,boolean>;blocked:number;activeMitigation:'NOT_TESTED'};
type Broker=(value:VerificationRequest)=>Promise<VerificationResponse>;

// No redirects, cookies, authentication, proxy environment, automatic DNS
// fallback, compression or unbounded response bodies. Addresses are pinned to
// the validated DNS result and TLS still checks the original hostname.
export function publicHttpsBroker(target?:string,signal?:AbortSignal):Broker {
  const pins=new Map<string,Promise<string>>();
  let total=0;
  return async value=>{
    signal?.throwIfAborted();
    const url=new URL(value.url);
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.hostname.endsWith('.')||!url.hostname.includes('.'))throw Error('HTTPS target required');
    if(!pins.has(url.hostname))pins.set(url.hostname,(async()=>{
      let deadline:ReturnType<typeof setTimeout>|undefined;
      const addresses=await Promise.race([lookup(url.hostname,{all:true}),new Promise<never>((_accept,reject)=>{deadline=setTimeout(()=>reject(Error('DNS deadline')),1500);})]).finally(()=>clearTimeout(deadline));
      if(!addresses.length||addresses.length>16||addresses.some(a=>!publicAddress(a.address)))throw Error('nonpublic address denied');
      return addresses[0].address;
    })());
    const address=await pins.get(url.hostname)!;
    return new Promise<VerificationResponse>((accept,reject)=>{
      const req=request({hostname:address,port:443,servername:url.hostname,method:value.method,path:url.pathname+url.search,signal,
        headers:{host:url.hostname,'accept-encoding':'identity','content-type':'text/plain','user-agent':'AntiClone controlled installation check',...(target?{origin:new URL(target).origin,referer:target}:{})},rejectUnauthorized:true},res=>{
        const chunks:Buffer[]=[];let size=0;
        if((res.statusCode??500)>=300&&res.statusCode!==304 || res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(Error('redirect or encoded response denied'));return;}
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;total+=chunk.length;if(size>512*1024||total>2*1024*1024){res.destroy();reject(Error('response budget'));}else chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',()=>accept({status:res.statusCode??500,headers:Object.fromEntries(['content-type','content-security-policy','referrer-policy','x-content-type-options','access-control-allow-origin','cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy'].flatMap(name=>typeof res.headers[name]==='string'?[[name,res.headers[name] as string]]:[])),body:Buffer.concat(chunks)}));
      });
      const timer=setTimeout(()=>req.destroy(Error('HTTPS deadline')),4000);
      req.once('close',()=>clearTimeout(timer));req.once('error',reject);req.end(value.method==='POST'?value.body:undefined);
    });
  };
}

export function verificationPolicy(spec:VerificationSpec) {
  const target=new URL(spec.target);
  if(target.protocol!=='https:'||target.port||target.username||target.password||target.hash||target.search)throw new TypeError('canonical approved HTTPS page required');
  const path=(name:string)=>spec.distribution.paths?.[name]??name;
  const urls={bootstrap:spec.distribution.bases.SCRIPT+path('runtime.js'),core:spec.distribution.bases.SCRIPT+path('core.js'),fallback:spec.distribution.bases.SCRIPT+path('fallback.js'),html_canary:spec.distribution.bases.STATIC_ASSETS+path('html.gif'),css_canary:spec.distribution.bases.STATIC_ASSETS+path('css.gif'),observe:spec.distribution.bases.TELEMETRY+path('observe'),fallback_observe:spec.distribution.bases.TELEMETRY+path('observe/fallback')};
  for(const value of Object.values(urls)){const url=new URL(value);if(url.protocol!=='https:'||url.port||url.username||url.password)throw new TypeError('HTTPS runtime required');}
  return {urls,allow(value:VerificationRequest,type:string,mode:string){
    if(value.url.length>4096||value.body.length>2048)return false;
    const url=new URL(value.url);
    if(mode==='without_core'&&value.url===urls.core)return false;
    if(value.method==='GET'){
      if(value.body!=='')return false;
      if([urls.bootstrap,urls.core,urls.fallback].includes(value.url))return type==='script';
      if([urls.html_canary,urls.css_canary].includes(value.url))return type==='image';
      return value.url===spec.target||url.origin===target.origin&&['script','stylesheet','image','font'].includes(type);
    }
    if(value.method!=='POST'||![urls.observe,urls.fallback_observe].includes(value.url))return false;
    let body:Record<string,unknown>;try{body=JSON.parse(value.body);}catch{return false;}
    if(!body||Array.isArray(body)||body.origin!==target.origin||body.pathname!==target.pathname)return false;
    const keys=Object.keys(body).sort().join(',');
    return value.url===urls.fallback_observe?keys==='origin,pathname':keys==='origin,pathname,signals'&&!!body.signals&&typeof body.signals==='object'&&!Array.isArray(body.signals)&&Object.keys(body.signals).length===0;
  }};
}

let busy=false;
export async function runControlledCheck(spec:VerificationSpec,image:string,broker?:Broker):Promise<ControlledCheck> {
  if(busy)throw Error('verification busy');
  if(!/^[a-z0-9][a-z0-9/_.:@-]{0,200}$/.test(image))throw new TypeError('invalid verifier image');
  const policy=verificationPolicy(spec),name='anticlone-verifier-'+randomUUID();
  const abort=new AbortController(),transport=broker??publicHttpsBroker(spec.target,abort.signal);
  busy=true;
  const child=spawn('docker',['run','--name',name,'--log-driver','none','--label','anticlone.installation-id='+spec.distribution.installation,'-i','--network','none','--read-only','--cap-drop','ALL','--user','1000:1000','--security-opt','no-new-privileges:true','--security-opt','seccomp='+resolve('infra/verifier/seccomp.json'),'--memory','512m','--pids-limit','128','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/home/pwuser:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=700',image],{stdio:['pipe','pipe','pipe']});
  const layers:Record<string,boolean>={bootstrap:false,core:false,core_observation:false,fallback:false,fallback_independent:false,html_canary:false,css_canary:false};
  const hashes=new Map<string,string>();let incompatibleIsolation=false;
  let blocked=0,count=0,buffer='',done=false,loaded=false,failed=false;
  const started=new Date().toISOString();
  let timer:ReturnType<typeof setTimeout>;
  let outcome:ControlledCheck|undefined;
  try {
    outcome=await new Promise<ControlledCheck>(accept=>{
      const finish=()=>{const values=Object.values(layers),status=!done||!loaded||failed||incompatibleIsolation?'NOT_VERIFIED':values.every(Boolean)?'FULL':values.some(Boolean)?'PARTIAL':'UNSUPPORTED';accept({status,checkedAt:started,scope:'CONTROLLED_BROWSER_CURRENT_LOAD',reason:incompatibleIsolation?'ISOLATION_POLICY_NOT_REPRODUCED':status==='NOT_VERIFIED'?'CHECK_FAILED':status==='FULL'?'ALL_INSTALLATION_CHANNELS_OBSERVED':'CHANNELS_UNAVAILABLE',layers:{...layers},blocked,activeMitigation:'NOT_TESTED'});};
      timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},25000);
      child.stderr.on('data',()=>{/* no browser/page diagnostics or credentials retained */});
      child.stdin.on('error',()=>{/* close handled below */});
      child.on('error',()=>{failed=true;finish();});
      child.on('close',code=>{if(code!==0)failed=true;finish();});
      child.stdout.on('data',(chunk:Buffer)=>{
        buffer+=chunk.toString();if(buffer.length>16384){failed=true;child.kill('SIGKILL');return;}
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          let data:Record<string,unknown>;try{data=JSON.parse(line);}catch{failed=true;child.kill('SIGKILL');return;}
          if(data.done===true){
            done=true;loaded=Array.isArray(data.runs)&&data.runs.length===3&&data.runs.every(r=>r&&typeof r==='object'&&r.loaded===true);
            const executed=new Set<string>();
            if(!Array.isArray(data.scripts)||data.scripts.length>9){failed=true;child.kill('SIGKILL');return;}
            for(const script of data.scripts){if(script&&typeof script==='object'&&typeof script.url==='string'&&typeof script.mode==='string'&&hashes.get(script.mode+':'+script.url)===script.sha256){if(script.mode==='without_javascript')failed=true;executed.add(script.mode+':'+script.url);}}
            for(const layer of ['bootstrap','core','fallback'] as const)layers[layer]=executed.has('normal:'+policy.urls[layer]);
            layers.fallback_independent=layers.fallback_independent&&executed.has('without_core:'+policy.urls.fallback);
            const canaries=data.canaries as {html?:boolean;css?:boolean}|undefined;
            layers.html_canary=layers.html_canary&&canaries?.html===true;layers.css_canary=layers.css_canary&&canaries?.css===true;
            continue;
          }
          if(++count>64||!Number.isSafeInteger(data.id)||typeof data.url!=='string'||typeof data.body!=='string'||typeof data.type!=='string'||!['normal','without_core','without_javascript'].includes(String(data.mode))||!['GET','POST'].includes(String(data.method))){failed=true;child.kill('SIGKILL');return;}
          const request={url:data.url,method:data.method as 'GET'|'POST',body:data.body};
          void (async()=>{
            let authorized=false;
            try {
              if(!policy.allow(request,data.type as string,data.mode as string))throw Error('request denied');
              authorized=true;
              abort.signal.throwIfAborted();
              const response=await transport(request);
              abort.signal.throwIfAborted();
              if(response.body.length>512*1024||!Number.isInteger(response.status)||response.status<200||response.status>=300)throw Error('response denied');
              // Playwright route fulfillment does not reproduce COEP/CORP in
              // all cases. Preserve headers but explicitly refuse certification.
              if(['cross-origin-embedder-policy','cross-origin-opener-policy'].some(name=>response.headers[name]&&response.headers[name]!=='unsafe-none')||response.headers['cross-origin-resource-policy']&&response.headers['cross-origin-resource-policy']!=='cross-origin')incompatibleIsolation=true;
              if([policy.urls.bootstrap,policy.urls.core,policy.urls.fallback].includes(request.url)&&data.type==='script')hashes.set(data.mode+':'+request.url,createHash('sha256').update(response.body).digest('hex'));
              if(data.mode==='normal'){
                if(request.url===policy.urls.observe)layers.core_observation=true;
              }
              if(data.mode==='without_core'&&request.url===policy.urls.fallback_observe)layers.fallback_independent=true;
              if(data.mode==='without_javascript')for(const layer of ['html_canary','css_canary'] as const)if(request.url===policy.urls[layer])layers[layer]=true;
              if(data.mode==='without_javascript'&&request.url===spec.target)response.headers['content-security-policy']=(response.headers['content-security-policy']?response.headers['content-security-policy']+', ':'')+"script-src 'none'";
              child.stdin.write(JSON.stringify({id:data.id,...response,body:response.body.toString('base64')})+'\n');
            }catch{
              if(authorized&&(request.url===spec.target||Object.values(policy.urls).includes(request.url)))failed=true;
              blocked++;child.stdin.write(JSON.stringify({id:data.id,blocked:true})+'\n');
            }
          })();
        }
      });
      child.stdin.write(JSON.stringify({target:spec.target,scriptUrls:[policy.urls.bootstrap,policy.urls.core,policy.urls.fallback],canaries:{html:policy.urls.html_canary,css:policy.urls.css_canary}})+'\n');
    });
    return outcome;
  }finally{
    clearTimeout(timer!);
    abort.abort();
    child.kill('SIGKILL');
    // Killing docker's client does not necessarily stop the container. Remove
    // only the random name owned by this invocation, before releasing admission.
    const removed=await new Promise<boolean>(complete=>{const stop=spawn('docker',['rm','-f',name],{stdio:'ignore'});stop.on('error',()=>complete(false));stop.on('close',code=>complete(code===0));setTimeout(()=>{stop.kill('SIGKILL');complete(false);},5000).unref();});
    if(!removed&&outcome){outcome.status='NOT_VERIFIED';outcome.reason='CONTAINER_CLEANUP_FAILED';}
    // Unknown cleanup keeps admission closed until operator reconciliation/restart.
    busy=!removed;
  }
}
