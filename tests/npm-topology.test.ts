import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {randomUUID,scryptSync} from 'node:crypto';
import {TOTP,Secret} from 'otpauth';
import {syntheticTls} from './npm-fixture.js';

test('NPM Compose: fresh001-064, actual private SSH admin, isolation and remote monitor',{timeout:180000,skip:process.env.HTTPS_GATE_TEST!=='1'?'requires Linux Docker; mandatory in CI':false},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'npm-topology-')),project='npmtest'+randomUUID().replaceAll('-',''),proxy=project+'proxy';
  const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const tls=await syntheticTls(dir);
  await writeFile(join(dir,'client-ca.crt'),await readFile(join(dir,'proxy.crt'),'utf8')+await readFile(join(dir,'monitor.crt'),'utf8'));
  await writeFile(join(dir,'server-ca.crt'),await readFile(join(dir,'server.crt')));
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',salt='0123456789abcdef0123456789abcdef';
  const record=`scrypt$${salt}$${scryptSync('private password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const envFile=async(name:string,values:Record<string,string>)=>writeFile(join(dir,name),Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
  await writeFile(join(dir,'password'),'synthetic-test-only');
  await envFile('gateway.env',{DATABASE_URL:'postgres://anticlone:synthetic-test-only@postgres/anticlone',SMTP_PORT:'1',PUBLIC_GATEWAY_HOST:'gateway.test',NPM_PROXY_FINGERPRINT:tls.NPM_PROXY_FINGERPRINT,NPM_MONITOR_FINGERPRINT:tls.NPM_MONITOR_FINGERPRINT});
  await envFile('admin.env',{DATABASE_URL:'postgres://anticlone:synthetic-test-only@localhost/anticlone?host=/run/anticlone-db',ADMIN_PASSWORD_RECORD:record,ADMIN_TOTP_SECRET:secret});
  await envFile('worker.env',{DATABASE_URL:'postgres://anticlone:synthetic-test-only@postgres/anticlone',PUBLIC_GATEWAY_HOST:'gateway.test'});
  await envFile('compose.env',{GATEWAY_IMAGE:'anticlone-pilot:test',POSTGRES_IMAGE:'postgres:16',NPM_PROXY_NETWORK:proxy,GATEWAY_ENV_FILE:join(dir,'gateway.env'),ADMIN_ENV_FILE:join(dir,'admin.env'),WORKER_ENV_FILE:join(dir,'worker.env'),DATABASE_PASSWORD_FILE:join(dir,'password'),GATEWAY_TLS_DIRECTORY:dir,MONITOR_TLS_DIRECTORY:dir});
  // Only synthetic fixture keys: Node uid1000 and the fixture SSH root need access.
  await chmod(dir,0o755);for(const file of await readdir(dir))if(/\.(key|crt)$/.test(file))await chmod(join(dir,file),0o444);
  const compose=['compose','--env-file',join(dir,'compose.env'),'-p',project,'-f','infra/npm/compose.yaml'];
  const sshContainer=project+'ssh';
  try{
    docker(['network','create',proxy]);
    const config=JSON.parse(docker([...compose,'--profile','notifications','config','--format','json']));
    for(const [name,service] of Object.entries(config.services) as [string,{ports?:unknown;networks?:Record<string,unknown>;network_mode?:string}][]){
      assert.equal(service.ports,undefined,name+' has no published port');
      if(name==='admin'){assert.equal(service.network_mode,'host');assert.equal(service.networks,undefined);}
      else {assert.equal(service.network_mode,undefined);assert.equal(!!service.networks?.proxy,name==='gateway');}
    }
    assert.equal(config.networks.private.internal,true);
    docker([...compose,'up','-d','--wait','postgres','gateway','admin']);
    const id=(name:string)=>docker([...compose,'ps','-q',name]).trim();
    const pg=id('postgres'),gateway=id('gateway'),admin=id('admin');
    const inspect=(container:string)=>JSON.parse(docker(['inspect',container]))[0];
    for(const container of [pg,gateway,admin])assert.deepEqual(inspect(container).HostConfig.PortBindings,{});
    assert.deepEqual(Object.keys(inspect(pg).NetworkSettings.Networks),[project+'_private']);
    assert.equal(inspect(admin).HostConfig.NetworkMode,'host');
    // Admin's real DB connection is via the mounted Unix socket, not a host-published TCP port.
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch('http://127.0.0.1:3001/admin/session')).status===401;}catch{/* starting */}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
    assert.match(docker(['exec',pg,'sh','-c','PGPASSWORD=synthetic-test-only psql -h /var/run/postgresql -U anticlone -d anticlone -Atc "select to_regclass(\'commerce_connection_versions\') is not null"']),/t/);
    // Network members without the proxy credential cannot speak to the gateway.
    const attack=`const h=await import('node:https');const q=h.request({host:'anticlone-personal-public',port:3000,rejectUnauthorized:false},()=>process.exit(2));q.on('error',()=>process.exit(0));q.end();`;
    docker(['run','--rm','--network',proxy,'--entrypoint','node','anticlone-pilot:test','--input-type=module','-e',attack]);
    const gatewayIp=inspect(gateway).NetworkSettings.Networks[proxy].IPAddress;
    assert.ok(gatewayIp);
    // A bridge client cannot reach an admin listener bound only to host loopback.
    const denyAdmin=`import{connect}from'node:net';const s=connect(3001,process.argv[1]);s.on('connect',()=>process.exit(2));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500);`;
    const hostGateway=JSON.parse(docker(['network','inspect',proxy]))[0].IPAM.Config[0].Gateway;
    docker(['run','--rm','--network',proxy,'--entrypoint','node','anticlone-pilot:test','--input-type=module','-e',denyAdmin,hostGateway]);
    const dbIp=inspect(pg).NetworkSettings.Networks[project+'_private'].IPAddress;
    docker(['run','--rm','--network',proxy,'--entrypoint','node','anticlone-pilot:test','--input-type=module','-e',denyAdmin.replace('connect(3001','connect(5432'),dbIp]);
    docker(['exec',admin,'node','--input-type=module','-e',`import{Pool}from'pg';const db=new Pool({host:'/run/anticlone-db',user:'anticlone',database:'anticlone',password:'wrong',connectionTimeoutMillis:1000});try{await db.query('select 1');process.exitCode=2;}catch(e){if(e.code!=='28P01')throw e;}finally{await db.end();}`]);
    // Actual SSH direct-tcpip channel (-W), identical remote socket to an SSH -L tunnel.
    execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,'ssh-key')],{stdio:'ignore'});
    await writeFile(join(dir,'sshd_config'),`ListenAddress 127.0.0.1\nPort 22222\nHostKey /fixture/ssh-key\nAuthorizedKeysFile /fixture/ssh-key.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:3001\nPidFile /tmp/sshd.pid\n`);
    docker(['run','-d','--name',sshContainer,'--network','host','-v',dir+':/fixture:ro','anticlone-ssh:test']);
    const sshArgs=['-T','-i',join(dir,'ssh-key'),'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-p','22222','-W','127.0.0.1:3001','root@127.0.0.1'];
    const ssh=async(method:string,path:string,body='',headers:Record<string,string>={})=>{
      const input=`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:3001\r\nConnection: close\r\n${Object.entries(headers).map(([k,v])=>k+': '+v+'\r\n').join('')}${body?'Content-Length: '+Buffer.byteLength(body)+'\r\n':''}\r\n${body}`;
      return new Promise<string>((resolve,reject)=>{const child=spawn('ssh',sshArgs,{stdio:['pipe','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('SSH HTTP timeout '+path));},15000);child.stdout.on('data',c=>output+=String(c));child.stderr.on('data',c=>error+=String(c));child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(error));else resolve(output);});child.stdin.write(input);});
    };
    for(let i=0;i<50;i++){if(spawnSync('ssh',sshArgs,{input:'',timeout:1000,stdio:'ignore'}).status===0)break;await new Promise(r=>setTimeout(r,100));}
    const bootstrap=await ssh('GET','/admin/ui/bootstrap','',{'Sec-Fetch-Site':'same-origin'});
    const loginCookie=/set-cookie: ([^;\r\n]+)/i.exec(bootstrap)?.[1];assert.ok(loginCookie);
    const csrf=/"csrf":"([a-f0-9]+)"/.exec(bootstrap)?.[1];assert.ok(csrf);
    const loginHeaders={'Content-Type':'application/json',Origin:'http://127.0.0.1:3001','Sec-Fetch-Site':'same-origin','X-CSRF-Token':csrf,Cookie:loginCookie};
    const code=new TOTP({secret:Secret.fromBase32(secret)}).generate();
    const body=JSON.stringify({password:'private password',code});
    assert.match(await ssh('POST','/admin/ui/login',body,{'Content-Type':'application/json'}),/HTTP\/1.1 403/);
    const login=await ssh('POST','/admin/ui/login',body,loginHeaders);assert.match(login,/HTTP\/1.1 204/);
    const cookie=/set-cookie: ([^;\r\n]+)/i.exec(login)?.[1];assert.ok(cookie);assert.match(login,/HttpOnly/i);assert.match(login,/SameSite=Strict/i);
    assert.match(await ssh('POST','/admin/ui/login',body,loginHeaders),/HTTP\/1.1 401/,'TOTP replay rejected');
    assert.match(await ssh('GET','/admin/ui/projects','',{Cookie:cookie,'Sec-Fetch-Site':'same-origin'}),/HTTP\/1.1 200/);
    assert.match(await ssh('POST','/admin/ui/logout','',{Cookie:cookie,Origin:'http://evil.test'}),/HTTP\/1.1 403/);
    // Monitor executed from the worker network, using its real production helper and TLS files.
    const session=await ssh('GET','/admin/ui/bootstrap','',{Cookie:cookie,'Sec-Fetch-Site':'same-origin'});
    const sessionCsrf=/"csrf":"([a-f0-9]+)"/.exec(session)?.[1];assert.ok(sessionCsrf);
    assert.match(await ssh('POST','/admin/ui/logout','{}',{...loginHeaders,Cookie:cookie,'X-CSRF-Token':sessionCsrf}),/HTTP\/1.1 204/);
    assert.match(await ssh('GET','/admin/ui/projects','',{Cookie:cookie,'Sec-Fetch-Site':'same-origin'}),/HTTP\/1.1 401/);
    const probe=`import{Pool}from'pg';import{localGatewayMonitor}from'./dist/apps/local-gateway-monitor.js';import{enableInstallation}from'./dist/apps/installation.js';import{configureHealth}from'./dist/apps/health-alerts.js';const db=new Pool({connectionString:process.env.DATABASE_URL});await db.query("INSERT INTO projects(id,name,origin) VALUES('probe','Probe','https://owner.test') ON CONFLICT DO NOTHING");await enableInstallation(db,'probe');await configureHealth(db,'probe',false,60,true);await localGatewayMonitor(db,process.env)();await db.end();`;
    docker([...compose,'run','--rm','--no-deps','notifications','node','--input-type=module','-e',probe]);
    const episodes=()=>docker(['exec',pg,'sh','-c','PGPASSWORD=synthetic-test-only psql -h /var/run/postgresql -U anticlone -d anticlone -Atc "select count(*) from health_episodes where source=\'gateway_local\' and recovered_at is null and invalidated_at is null"']).trim();
    assert.equal(episodes(),'0');
    docker([...compose,'stop','gateway']);
    docker([...compose,'run','--rm','--no-deps','notifications','node','--input-type=module','-e',probe]);assert.equal(episodes(),'1');
    docker([...compose,'start','gateway']);await new Promise(r=>setTimeout(r,1500));
    docker([...compose,'run','--rm','--no-deps','notifications','node','--input-type=module','-e',probe]);assert.equal(episodes(),'0');
  }catch(error){
    process.stderr.write(docker([...compose,'logs','--tail','35','gateway','admin','postgres']));throw error;
  }finally{
    try{docker(['rm','-f',sshContainer]);}catch{/* not started */}
    // Only disposable project-owned volumes; deployment runbook never uses -v.
    try{docker([...compose,'--profile','notifications','down','-v']);}finally{try{docker(['network','rm',proxy]);}finally{await rm(dir,{recursive:true,force:true});}}
  }
});
