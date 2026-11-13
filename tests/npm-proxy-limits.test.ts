import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer,type ServerResponse} from 'node:http';
import {request} from 'node:https';
import {syntheticTls} from './npm-fixture.js';
import {npmServer} from '../apps/npm-transport.js';
import {npmProxyFixture} from './npm-proxy-fixture.js';

test('NPM independent config: mandatory pre-upstream rate/concurrency, unrelated host unaffected',{timeout:45000,skip:process.env.HTTPS_GATE_TEST!=='1'?'requires Linux Docker; mandatory in CI':false},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'npm-limits-')),name='anticlone-npm-limits-'+crypto.randomUUID();
  const tls=await syntheticTls(dir);
  let received=0,hold=false;
  const held=new Set<ServerResponse>();
  // No Node admission/rate boundary here: rejected traffic must be stopped by Nginx.
  const backend=npmServer(tls,(_req,res)=>{received++;if(hold){held.add(res);res.on('close',()=>held.delete(res));}else res.writeHead(200).end('synthetic');});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');const upstream=backend.address();assert.ok(upstream&&typeof upstream!=='string');
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const front=reserve.address();assert.ok(front&&typeof front!=='string');await new Promise<void>(r=>reserve.close(()=>r()));
  const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const logs=()=>{const result=spawnSync('docker',['logs',name],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout+result.stderr;};
  const send=(host='gateway.test',path='/runtime.js')=>new Promise<number>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:front.port,path,agent:false,rejectUnauthorized:false,headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.setTimeout(4000,()=>req.destroy(Error('fixture HTTP timeout')));req.end();
  });
  try{
    for(const [target,source] of [['privkey.pem','server.key'],['fullchain.pem','server.crt'],['server-ca.crt','server.crt'],['npm.key','proxy.key'],['npm.crt','proxy.crt']])await writeFile(join(dir,target),await readFile(join(dir,source)));
    const other=`server { listen ${front.port} ssl; server_name other.test; ssl_certificate /run/tls/fullchain.pem; ssl_certificate_key /run/tls/privkey.pem; location / { proxy_pass https://127.0.0.1:${upstream.port}; proxy_ssl_certificate /run/tls/npm.crt; proxy_ssl_certificate_key /run/tls/npm.key; proxy_ssl_trusted_certificate /run/tls/server-ca.crt; proxy_ssl_verify on; proxy_ssl_server_name on; proxy_ssl_name gateway.test; } }`;
    await npmProxyFixture(dir,`127.0.0.1:${upstream.port}`,front.port,other);
    // The envelope/helper contain no direct-profile config or hidden limit declarations.
    const envelope=await readFile('tests/fixtures/npm-nginx.conf','utf8');
    assert.doesNotMatch(envelope,/limit_req_zone|limit_conn_zone|limit_req\s|limit_conn\s/);
    assert.doesNotMatch(await readFile('tests/npm-proxy-fixture.ts','utf8'),/infra\/https/);
    const config=await readFile(join(dir,'nginx.conf'),'utf8');
    const check=()=>spawnSync('docker',['run','--rm','--network','host','--tmpfs','/tmp','-v',dir+':/run/tls:ro','--entrypoint','nginx','nginx:1.28-alpine','-t','-c','/run/tls/nginx.conf'],{encoding:'utf8'});
    const valid=check();assert.equal(valid.status,0,valid.stderr);
    await writeFile(join(dir,'nginx.conf'),config.replace('include /run/tls/http-limits.conf;',''));
    assert.notEqual(check().status,0,'missing HTTP zones blocks nginx -t/publication');
    await writeFile(join(dir,'nginx.conf'),config);
    await chmod(dir,0o755);for(const file of await readdir(dir))await chmod(join(dir,file),0o444);
    docker(['run','-d','--name',name,'--network','host','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','-v',dir+':/run/tls:ro','-v',dir+'/nginx.conf:/etc/nginx/nginx.conf:ro','nginx:1.28-alpine']);
    const ready=async()=>{for(let i=0;i<50;i++){try{if(await send()===200)return;}catch{/* starting */}await new Promise(r=>setTimeout(r,30));}throw Error('NPM fixture not ready');};
    await ready();for(let i=0;i<3;i++)assert.equal(await send(),200,'normal traffic');
    const beforeRate=received,statuses:number[]=[];
    for(let i=0;i<40;i++)statuses.push(await send());
    assert.ok(statuses.includes(200));assert.ok(statuses.includes(429));
    assert.equal(received-beforeRate,statuses.filter(s=>s===200).length,'429 never reached upstream');
    assert.match(logs(),/limiting requests.*anticlone_personal_requests/);
    const beforeOther=received;
    for(let i=0;i<40;i++)assert.equal(await send('other.test'),200,'other Proxy Host unchanged even while AntiClone is saturated');
    assert.equal(received-beforeOther,40);
    docker(['restart',name]);await ready();
    hold=true;const beforeConnections=received;
    const active=Array.from({length:10},()=>send('gateway.test','/core.js'));
    for(let i=0;i<100&&held.size<10;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(held.size,10,'ten requests admitted and held upstream');
    assert.equal(await send('gateway.test','/core.js'),429,'eleventh active request rejected before upstream');
    assert.equal(received-beforeConnections,10);
    assert.match(logs(),/limiting connections.*anticlone_personal_connections/);
    hold=false;for(const res of held)res.writeHead(200).end('released');assert.deepEqual(await Promise.all(active),Array(10).fill(200));
    assert.equal(await send(),200,'capacity released after requests finish');
  }finally{
    for(const res of held)res.destroy();
    try{docker(['rm','-f',name]);}catch{/* fixture may not have started */}
    backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));await rm(dir,{recursive:true,force:true});
  }
});
