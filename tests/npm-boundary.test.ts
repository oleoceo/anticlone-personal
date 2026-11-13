import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticTls} from './npm-fixture.js';
import {once} from 'node:events';
import {request} from 'node:https';
import {gatewayBoundary} from '../apps/gateway-boundary.js';
import {npmServer} from '../apps/npm-transport.js';

test('NPM TLS authenticates certificate pins, rejects ambiguous claims and bounds budgets',{timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'npm-boundary-'));
  const env=await syntheticTls(dir);
  // Trusting a CA/certificate alone is insufficient: a trusted but unpinned peer is denied.
  const {writeFile}=await import('node:fs/promises');
  await writeFile(join(dir,'clients.crt'),await readFile(join(dir,'proxy.crt'),'utf8')+await readFile(join(dir,'monitor.crt'),'utf8')+await readFile(join(dir,'stranger.crt'),'utf8'));
  env.NPM_CLIENT_CA_FILE=join(dir,'clients.crt');
  const boundary=gatewayBoundary(env);
  const server=npmServer(env,(req,res)=>{if(boundary(req,res))res.writeHead(204).end();});
  server.maxHeadersCount=40;server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const ca=await readFile(join(dir,'server.crt'));
  const headers={host:'gateway.test','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.1'};
  const send=async(name:string|null='proxy',patch:Record<string,string|string[]|undefined>={},path='/runtime.js')=>{
    const identity=name?{cert:await readFile(join(dir,name+'.crt')),key:await readFile(join(dir,name+'.key'))}:{};
    return new Promise<number>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:addr.port,servername:'gateway.test',ca,...identity,path,headers:{...headers,...patch}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();});
  };
  try{
    assert.throws(()=>gatewayBoundary({...env,NPM_MONITOR_FINGERPRINT:env.NPM_PROXY_FINGERPRINT}));
    await assert.rejects(send(null));
    assert.equal(await send('stranger'),403);
    assert.equal(await send('monitor'),403);assert.equal(await send('monitor',{},'/healthz'),204);
    for(const patch of [{host:'evil.test'},{'x-forwarded-proto':'http'},{'x-forwarded-for':'192.0.2.1, 192.0.2.2'},{'x-forwarded-for':''},{forwarded:'for=192.0.2.1'},{'x-real-ip':'192.0.2.1'},{'cf-connecting-ip':'192.0.2.1'},{'x-forwarded-host':'gateway.test'},{'x-forwarded-for':['192.0.2.1','192.0.2.2']},{...Object.fromEntries(Array.from({length:41},(_,i)=>['padding'+i,'x'])),forwarded:'for=evil'}])assert.ok([400,431].includes(await send('proxy',patch)));
    for(let i=0;i<120;i++)assert.equal(await send(),204);
    assert.equal(await send(),429);
    for(let i=0;i<1080;i++)assert.equal(await send('proxy',{'x-forwarded-for':`2001:db8::${(i+1).toString(16)}`}),i===1079?429:204);
    assert.equal(await send('monitor',{},'/healthz'),204);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
