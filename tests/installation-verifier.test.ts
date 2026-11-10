import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,request} from 'node:https';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {createSocket} from 'node:dgram';
import {publicHttpsBroker,verificationPolicy,runControlledCheck,type VerificationResponse} from '../apps/installation-verifier.js';
import {distributionAdmin,distributionSnippets,verifyPublishedInstallation,type Distribution} from '../apps/runtime-distribution.js';
import {distributionGateway} from '../apps/distribution-gateway.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {projectMaintenance} from '../apps/project-maintenance.js';

test('verification broker rejects private DNS, URL injection, foreign requests and data-bearing posts',async()=>{
  const distribution:Distribution={installation:randomUUID(),version:1,bases:{SCRIPT:'https://gateway.test/s/',TELEMETRY:'https://gateway.test/t/',STATIC_ASSETS:'https://gateway.test/a/'}};
  const policy=verificationPolicy({target:'https://owner.test/page',distribution});
  const allow=(url:string,method:'GET'|'POST'='GET',body='')=>policy.allow({url,method,body},'script','normal');
  for(const url of ['http://169.254.169.254/latest/meta-data','http://127.0.0.1/','file:///etc/passwd','https://other.test/a.js'])assert.equal(allow(url),false);
  assert.equal(allow('https://gateway.test/t/observe','POST',JSON.stringify({origin:'https://owner.test',pathname:'/page',signals:{}})),true);
  for(const body of [{origin:'https://evil.test',pathname:'/page',signals:{}},{origin:'https://owner.test',pathname:'/page',signals:{email:'private'}},{origin:'https://owner.test',pathname:'/page',signals:{},extra:'data'}])assert.equal(allow('https://gateway.test/t/observe','POST',JSON.stringify(body)),false);
  const fetch=publicHttpsBroker();
  for(const url of ['http://127.0.0.1/','https://127.0.0.1/','https://169.254.169.254/','https://user:pass@owner.test/'])await assert.rejects(fetch({url,method:'GET',body:''}));
});

test('network-none sandboxed Chromium + mediated real TLS/PostgreSQL: FULL, CSP PARTIAL/UNSUPPORTED, failure and stale snapshot',{timeout:180000,skip:process.env.HTTPS_GATE_TEST!=='1'?'requires isolated Docker verifier; mandatory in CI':false},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='verifier_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const dir=await mkdtemp(join(tmpdir(),'verifier-'));
  const original='https://owner.verifier.test',gateway='https://gateway.verifier.test',page=randomUUID(),installation=randomUUID();
  let policy='',html='',css='',coep='',submitted=0,networkCalls=0,stale=false,isolationChecked=false,udpPackets=0;
  const udp=createSocket('udp4');udp.on('message',()=>udpPackets++);udp.bind(0,'127.0.0.1');await once(udp,'listening');const udpPort=udp.address().port;
  const scripts=Object.fromEntries(await Promise.all([['runtime.js','bootstrap.js'],['core.js','core.js'],['fallback.js','fallback.js']].map(async([name,file])=>[name,await readFile('runtime/'+file)])));
  const maintenance=projectMaintenance(db,{SMTP_PORT:'1'});
  const scoped=scopedGateway(db,scripts,maintenance.collect);
  const distributed=distributionGateway(db,scripts,(req,res)=>{if(!scoped(req,res))res.writeHead(404).end();});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=owner.verifier.test','-addext','subjectAltName=DNS:owner.verifier.test,DNS:gateway.verifier.test'],{stdio:'ignore'});
  const cert=await readFile(join(dir,'cert'));
  const server=createServer({key:await readFile(join(dir,'key')),cert},(req,res)=>{
    networkCalls++;
    if(req.headers.host==='gateway.verifier.test'){if(!distributed(req,res)&&!scoped(req,res))res.writeHead(404).end();return;}
    if(req.method!=='GET'){submitted++;res.writeHead(405).end();return;}
    if(policy)res.setHeader('content-security-policy',policy);
    if(coep)res.setHeader('cross-origin-embedder-policy',coep);
    res.writeHead(200,{'content-type':'text/html'}).end(`<style>${css}</style><div class="anticlone-canary">Owned LP</div><a href="/native">Native checkout</a><form action="/submit" method="post"><input name="email"></form>${html}<script>fetch('http://169.254.169.254/latest/meta-data');new WebSocket('ws://127.0.0.1:9');</script>`);
  }).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  // This test-only broker maps the two synthetic HTTPS names to its own TLS
  // socket and CA. Production publicHttpsBroker never permits this loopback.
  const broker=async(value:{url:string;method:'GET'|'POST';body:string}):Promise<VerificationResponse>=>{
    const url=new URL(value.url);assert.ok([original,gateway].includes(url.origin),'foreign/metadata requests never reach a network broker');
    if(!isolationChecked){
      const id=execFileSync('docker',['ps','--filter','label=anticlone.installation-id='+installation,'--format','{{.ID}}'],{stdio:'pipe'}).toString().trim();assert.match(id,/^[a-f0-9]+$/);
      const config=JSON.parse(execFileSync('docker',['inspect',id],{stdio:'pipe'}).toString())[0];
      assert.equal(config.HostConfig.NetworkMode,'none');assert.equal(config.HostConfig.LogConfig.Type,'none');assert.equal(config.HostConfig.Privileged,false);assert.equal(config.HostConfig.ReadonlyRootfs,true);assert.deepEqual(config.HostConfig.CapDrop,['ALL']);assert.equal(config.Config.User,'1000:1000');assert.ok(config.HostConfig.SecurityOpt.includes('no-new-privileges:true'));assert.ok(config.HostConfig.SecurityOpt.some((v:string)=>v.startsWith('seccomp=')));assert.equal(config.Mounts.filter((m:{Type:string})=>m.Type==='bind').length,0);
      assert.match(execFileSync('docker',['exec',id,'cat','/proc/1/status'],{stdio:'pipe'}).toString(),/CapEff:\s+0000000000000000/);
      execFileSync('docker',['exec',id,'node','-e',`const n=require('node:net').connect(${address.port},'127.0.0.1');n.once('connect',()=>process.exit(1));n.once('error',()=>process.exit(0));setTimeout(()=>process.exit(2),1000);`],{stdio:'pipe'});
      execFileSync('docker',['exec',id,'node','-e',`const s=require('node:dgram').createSocket('udp4');s.send('F08',${udpPort},'127.0.0.1',()=>s.close());`],{stdio:'pipe'});
      isolationChecked=true;
    }
    if(stale&&value.url===original+'/page'){stale=false;await db.query('UPDATE protected_pages SET config_generation=config_generation+1 WHERE id=$1',[page]);}
    return new Promise((accept,reject)=>{
      const req=request({hostname:'127.0.0.1',port:address.port,servername:url.hostname,ca:cert,method:value.method,path:url.pathname+url.search,headers:{host:url.hostname,origin:original,referer:original+'/page','content-type':'text/plain'}},res=>{
        const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>chunks.push(b));res.on('end',()=>accept({status:res.statusCode??500,headers:Object.fromEntries(Object.entries(res.headers).filter(([key,value])=>['content-type','content-security-policy','access-control-allow-origin','cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy'].includes(key)&&typeof value==='string')) as Record<string,string>,body:Buffer.concat(chunks)}));res.on('error',reject);
      });req.on('error',reject);req.end(value.method==='POST'?value.body:undefined);
    });
  };
  try{
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('owner','Owner',$1),('other','Other','https://other.verifier.test')",[original]);
    await db.query('INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,$2,$3,$4)',[page,'owner',installation,'LP']);
    await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[page,original,'/page']);
    const distribution=(await distributionAdmin(db,{action:'publish',project:'owner',page},{RUNTIME_PUBLIC_ORIGIN:gateway})).distribution!;
    for(const invalid of [{status:null},{},{status:'SIMULATED'}])await assert.rejects(db.query('INSERT INTO controlled_installation_checks(id,project_id,page_id,distribution_version,url_generation,config_generation,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),'owner',page,distribution.version,0,0,invalid]),{code:'23514'});
    const snippets=distributionSnippets(distribution);html=snippets.html;css=snippets.css;
    const spec={target:original+'/page',distribution},image='anticlone-verifier:test';
    const run=(input:typeof spec,selectedImage:string)=>runControlledCheck(input,selectedImage,broker);
    const env={INSTALLATION_VERIFIER_IMAGE:image};
    const full=await verifyPublishedInstallation(db,'owner',page,env,run);
    assert.equal(full.status,'FULL',JSON.stringify(full));assert.equal(full.activeMitigation,'NOT_TESTED');assert.ok(full.blocked>0);
    assert.ok(Object.values(full.layers).every(Boolean));assert.ok(networkCalls>10);
    assert.equal((await distributionAdmin(db,{action:'inspect',project:'owner',page})).diagnostic?.status,'FULL');
    assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0,'original check does not create a copy incident');
    assert.deepEqual((await db.query("SELECT source FROM page_installation_signals WHERE page_id=$1 ORDER BY source",[page])).rows.map(r=>r.source),['core','fallback'],'real gateway persists both observed channels');
    assert.equal(submitted,0,'verification never submits the native form');
    const scriptUrl=(name:string)=>distribution.bases.SCRIPT+(distribution.paths?.[name]??name);
    const observeUrl=distribution.bases.TELEMETRY+(distribution.paths?.observe??'observe');
    const fallbackUrl=distribution.bases.TELEMETRY+(distribution.paths?.['observe/fallback']??'observe/fallback');
    html=`<img src="${distribution.bases.STATIC_ASSETS+(distribution.paths?.['html.gif']??'html.gif')}">${['runtime.js','core.js','fallback.js'].map(name=>`<link rel="preload" as="script" href="${scriptUrl(name)}"><img src="${scriptUrl(name)}">`).join('')}<script>fetch(${JSON.stringify(observeUrl)},{method:'POST',body:JSON.stringify({origin:location.origin,pathname:location.pathname,signals:{}})});fetch(${JSON.stringify(fallbackUrl)},{method:'POST',body:JSON.stringify({origin:location.origin,pathname:location.pathname})});</script>`;
    const forged=await run(spec,image);assert.notEqual(forged.status,'FULL');assert.equal(forged.layers.core,false,'preload/image/fake POST is not runtime execution');assert.equal(forged.layers.bootstrap,false);
    html=snippets.html;coep='require-corp';const isolatedPolicy=await run(spec,image);assert.equal(isolatedPolicy.status,'NOT_VERIFIED');assert.equal(isolatedPolicy.reason,'ISOLATION_POLICY_NOT_REPRODUCED');coep='';
    policy=`default-src 'none'; img-src ${gateway}; style-src 'unsafe-inline'; script-src 'none'`;
    const partial=await run(spec,image);assert.equal(partial.status,'PARTIAL',JSON.stringify(partial));assert.equal(partial.layers.core,false);assert.equal(partial.layers.html_canary,true);
    policy="default-src 'none'";const unsupported=await run(spec,image);assert.equal(unsupported.status,'UNSUPPORTED',JSON.stringify(unsupported));
    policy='';const unavailable=await runControlledCheck(spec,image,async()=>{throw Error('synthetic HTTPS outage');});assert.equal(unavailable.status,'NOT_VERIFIED');
    const gatewayDown=await runControlledCheck(spec,image,async value=>{if(new URL(value.url).origin===gateway)throw Error('synthetic gateway outage');return broker(value);});assert.equal(gatewayDown.status,'NOT_VERIFIED','loaded document with unavailable gateway is not unsupported');
    stale=true;const changed=await verifyPublishedInstallation(db,'owner',page,env,run);assert.equal(changed.status,'NOT_VERIFIED');assert.equal(changed.reason,'CONFIGURATION_CHANGED');
    assert.equal((await distributionAdmin(db,{action:'inspect',project:'owner',page})).diagnostic?.status,'NOT_VERIFIED','old successful revision never validates new configuration');
    await assert.rejects(verifyPublishedInstallation(db,'other',page,env,run));
    await assert.rejects(distributionAdmin(db,{action:'verify',project:'owner',page,url:'http://169.254.169.254/'}));
    await assert.rejects(verifyPublishedInstallation(db,'owner',page,{},run),/not configured/);
    assert.equal((await db.query("SELECT count(*)::int n FROM controlled_installation_checks WHERE project_id='other'")).rows[0].n,0);
    assert.equal(udpPackets,0,'network-none prevents UDP/WebRTC egress to the host');
    await db.query("UPDATE controlled_installation_checks SET checked_at=now()-interval '8 days'");
    await maintenance();assert.equal((await db.query('SELECT count(*)::int n FROM controlled_installation_checks')).rows[0].n,0,'periodic retention expires checks even without a new verification');
    process.stdout.write('F08 controlled channels '+JSON.stringify({full,forged,isolatedPolicy,partial,unsupported,unavailable,gatewayDown,changed})+'\n');
  }finally{udp.close();await new Promise<void>(r=>server.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});}
});
