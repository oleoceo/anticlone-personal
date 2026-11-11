import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scryptSync } from 'node:crypto';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { chromium } from 'playwright';
import { TOTP, Secret } from 'otpauth';
import { smtpProvider, sendProviderAlert } from '../apps/smtp-provider.js';
import { deliverOne } from '../apps/alerts.js';
import { investigation } from '../apps/investigation.js';
import { createAdminServer } from '../apps/admin-auth.js';

const privateEnv={SMTP_PROVIDER:'smtp',SMTP_HOST:'localhost',SMTP_PORT:'465',SMTP_TLS:'implicit',SMTP_USER:'synthetic-user',SMTP_PASSWORD:'synthetic-private-password',SMTP_SENDER:'sender@example.test',SMTP_RECIPIENT:'owner@example.test'};
async function until(check:()=>Promise<boolean>, label:string) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {if(await check()) return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('timeout: '+label);
}
async function stop(child:ChildProcess) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const timer=setTimeout(()=>child.kill('SIGKILL'),4000);
  try {child.kill('SIGTERM');await once(child,'exit');}finally{clearTimeout(timer);}
}

test('private SMTP configuration rejects ambiguous recipients, plaintext and credential injection',()=>{
  assert.equal(smtpProvider({}),undefined);
  assert.equal(smtpProvider(privateEnv)?.tls_mode,'implicit');
  for(const delta of [{SMTP_PROVIDER:'unknown'},{SMTP_TLS:'none'},{SMTP_HOST:'smtp://host'},{SMTP_PORT:'0'},
    {SMTP_USER:''},{SMTP_PASSWORD:''},{SMTP_PASSWORD:'secret\r\nvalue'},{SMTP_RECIPIENT:'owner@example.test,other@example.test'},
    {SMTP_SENDER:'Name <owner@example.test>'},{SMTP_RECIPIENT:'owner@example.test\r\nBcc:x@example.test'}]) {
    assert.throws(()=>smtpProvider({...privateEnv,...delta}),/^Error: invalid private SMTP configuration$/);
  }
});

test('provider TLS, durable attempts, browser clone dedup, retry/restart and authenticated administrative history', {timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const dir=await mkdtemp(join(tmpdir(),'anticlone-smtp-'));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  const openssl=process.platform==='win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='smtp_provider_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const options=`-c search_path=${schema}`;
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options});
  let rejectAuth=true;
  const messages:string[]=[];
  const smtp=new SMTPServer({secure:true,key:await readFile(key),cert:await readFile(cert),
    onAuth(auth,_session,callback){
      if(rejectAuth || auth.username!==privateEnv.SMTP_USER || auth.password!==privateEnv.SMTP_PASSWORD) {callback(new Error('synthetic authentication rejection'));return;}
      callback(null,{user:auth.username});
    },onMailFrom(address,_session,callback){assert.equal(address.address,privateEnv.SMTP_SENDER);callback();},
    onRcptTo(address,_session,callback){assert.equal(address.address,privateEnv.SMTP_RECIPIENT);callback();},
    onData(stream,_session,callback){let text='';stream.on('data',chunk=>{text+=String(chunk);});stream.on('end',()=>{messages.push(text);callback();});}});
  smtp.on('error',()=>{}); // Expected TLS rejection is verified below.
  smtp.listen(0,'127.0.0.1');await once(smtp.server,'listening');
  const smtpPort=(smtp.server.address() as AddressInfo).port;
  const config=smtpProvider({...privateEnv,SMTP_PORT:String(smtpPort)})!;
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');
  const apiPort=(reserve.address() as AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const fixture=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<h1>Controlled original</h1><a href="/checkout">Checkout</a><script src="http://127.0.0.1:${apiPort}/runtime.js"></script>`)).listen(0,'127.0.0.1');await once(fixture,'listening');
  const fixturePort=(fixture.address() as AddressInfo).port, original=`http://127.0.0.1:${fixturePort}`,clone=`http://localhost:${fixturePort}`;
  let child:ChildProcess|undefined;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let adminServer:ReturnType<typeof createAdminServer>|undefined;
  const env={...process.env,...privateEnv,SMTP_PORT:String(smtpPort),NODE_EXTRA_CA_CERTS:cert,PGOPTIONS:options,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:'one',ALLOWED_ORIGIN:original,PORT:String(apiPort)};
  let logs='';
  const start=()=>{const process=spawn(globalThis.process.execPath,['dist/apps/server.js'],{env,stdio:['ignore','ignore','pipe']});process.stderr!.on('data',chunk=>{logs+=String(chunk);});return process;};
  try {
    for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','017_notification_settings','018_notification_budget','019_alert_outbox_expiry','033_clone_delivery_attempts']) await db.query((await readFile(`infra/${file}.sql`,'utf8')).replace(/^\uFEFF/,''));
    await db.query('INSERT INTO projects VALUES($1,$1,$2)', ['one',original]);
    await db.query("INSERT INTO projects VALUES('two','Other project','http://other.test')");
    await db.query(`UPDATE notification_settings SET provider=$1,host=$2,port=$3,tls_mode=$4,sender=$5,recipient=$6,requested=true`,[config.provider,config.host,config.port,config.tls_mode,config.sender,config.recipient]);
    // TLS certificate validation cannot be disabled by configuration.
    await assert.rejects(sendProviderAlert(config,'1','copy.test'));
    assert.equal(messages.length,0);
    child=start();
    await until(async()=>{try{return(await fetch(`http://127.0.0.1:${apiPort}/runtime.js`)).ok;}catch{return false;}},'gateway startup');
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    const page=await browser.newPage();
    await page.goto(original);
    await page.waitForTimeout(300);
    assert.equal((await db.query('SELECT * FROM incidents')).rowCount,0);
    assert.equal(await page.locator('a').getAttribute('href'),'/checkout');
    await page.goto(clone);
    await until(async()=>(await db.query("SELECT * FROM clone_delivery_attempts WHERE outcome='FAILED'")).rowCount===1,'provider failure persisted');
    await page.reload();
    await stop(child);child=undefined;
    const failed=(await investigation(db,'one'))[0];
    assert.equal(failed.notification.outbox.state,'PENDING');
    assert.equal(failed.notification.history[0].outcome,'FAILED');
    assert.equal((await db.query('SELECT * FROM incidents')).rowCount,1);
    // UI edits cannot grant authority to a different network destination or recipient.
    await db.query('UPDATE notification_settings SET recipient=$1',['other@example.test']);
    await deliverOne(db,'one',config);
    await db.query('UPDATE notification_settings SET recipient=$1,requested=false',[config.recipient]);
    await deliverOne(db,'one',config);
    assert.equal((await db.query('SELECT * FROM clone_delivery_attempts')).rowCount,1);
    await db.query('UPDATE notification_settings SET requested=true');
    rejectAuth=false;
    await db.query('UPDATE alert_outbox SET next_attempt=clock_timestamp()');
    child=start();
    await until(async()=>(await db.query('SELECT * FROM alert_outbox WHERE sent_at IS NOT NULL')).rowCount===1,'retry accepted after restart');
    assert.equal(messages.length,1);
    await page.reload();
    await stop(child);child=start();
    await until(async()=>{try{return(await fetch(`http://127.0.0.1:${apiPort}/runtime.js`)).ok;}catch{return false;}},'second restart');
    await page.reload();await page.waitForTimeout(300);
    assert.equal(messages.length,1);
    assert.equal((await db.query('SELECT * FROM incidents')).rowCount,1);
    const delivered=(await investigation(db,'one'))[0];
    assert.equal(delivered.notification.outbox.state,'ACCEPTED_BY_TRANSPORT');
    assert.deepEqual(delivered.notification.history.map((item:{outcome:string})=>item.outcome),['FAILED','ACCEPTED']);
    assert.equal((await investigation(db,'two')).length,0);
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',clock=1000000000;
    const record=`scrypt$${salt}$${scryptSync('test password',Buffer.from(salt,'hex'),64).toString('hex')}`;
    adminServer=createAdminServer(record,secret,db,()=>clock).listen(0,'127.0.0.1');await once(adminServer,'listening');
    const base=`http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;
    assert.equal((await fetch(base+'/admin/projects/one/investigation')).status,401);
    await page.goto(base+'/admin/ui/');
    await page.getByLabel('Senha administrativa').fill('test password');
    await page.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate({timestamp:clock}));
    await page.getByRole('button',{name:'Entrar'}).click();
    await page.locator('#incident-query select[name=project]').selectOption('one');
    await page.getByRole('button',{name:'Consultar incidentes'}).click();
    await page.locator('#incident-list p').filter({hasText:'Alerta inicial: ACCEPTED_BY_TRANSPORT'}).waitFor();
    const content=await page.locator('#incident-list').textContent();
    assert.match(content ?? '',/FAILED/);assert.match(content ?? '',/ACCEPTED/);
    assert.ok(!content?.includes(privateEnv.SMTP_PASSWORD));assert.ok(!content?.includes(privateEnv.SMTP_USER));
    await page.locator('#incident-query select[name=project]').selectOption('two');
    await page.getByRole('button',{name:'Consultar incidentes'}).click();
    await page.getByText('Nenhum incidente observado.').waitFor();
    assert.ok(!logs.includes(privateEnv.SMTP_PASSWORD));assert.ok(!logs.includes(privateEnv.SMTP_USER));
    assert.ok(!messages[0].includes(privateEnv.SMTP_PASSWORD));
    let tlsAuthenticated=false;
    const starttls=new SMTPServer({key:await readFile(key),cert:await readFile(cert),
      onAuth(auth,session,callback){tlsAuthenticated=session.secure;callback(null,{user:auth.username});},
      onData(stream,_session,callback){stream.resume();stream.on('end',()=>callback());}});
    starttls.listen(0,'127.0.0.1');await once(starttls.server,'listening');
    try {
      const sender=spawn(process.execPath,['--input-type=module','-e',"import {smtpProvider,sendProviderAlert} from './dist/apps/smtp-provider.js'; await sendProviderAlert(smtpProvider(process.env),'99','controlled.test');"],
        {env:{...env,SMTP_TLS:'starttls',SMTP_PORT:String((starttls.server.address() as AddressInfo).port)},stdio:'pipe'});
      let error='';sender.stderr.on('data',chunk=>{error+=String(chunk);});
      const [code]=await once(sender,'exit');assert.equal(code,0,error);assert.equal(tlsAuthenticated,true);
    } finally {await new Promise<void>(resolve=>starttls.close(()=>resolve()));}
    const delays:Array<ReturnType<typeof setTimeout>>=[];
    const later=(callback:()=>void)=>{delays.push(setTimeout(callback,2200));};
    let slowClosed=false;
    const slow=new SMTPServer({secure:true,key:await readFile(key),cert:await readFile(cert),
      onConnect(_session,callback){later(()=>callback());},
      onAuth(auth,_session,callback){later(()=>callback(null,{user:auth.username}));},
      onMailFrom(_address,_session,callback){later(()=>callback());},
      onRcptTo(_address,_session,callback){later(()=>callback());},
      onData(stream,_session,callback){stream.resume();stream.on('end',()=>later(()=>callback()));},
      onClose(){slowClosed=true;}});
    slow.on('error',()=>{});
    slow.listen(0,'127.0.0.1');await once(slow.server,'listening');
    try {
      const started=Date.now();
      const sender=spawn(process.execPath,['--input-type=module','-e',"import {smtpProvider,sendProviderAlert} from './dist/apps/smtp-provider.js'; await sendProviderAlert(smtpProvider(process.env),'100','controlled.test');"],
        {env:{...env,SMTP_PORT:String((slow.server.address() as AddressInfo).port)},stdio:'pipe'});
      let error='';sender.stderr.on('data',chunk=>{error+=String(chunk);});
      const [code]=await once(sender,'exit');assert.notEqual(code,0);assert.match(error,/SMTP total deadline/);
      assert.ok(Date.now()-started<13000,'total deadline releases the worker even when every reply is within the socket timeout');
      await until(async()=>slowClosed,'deadline closes SMTP socket');
    } finally {for(const delay of delays)clearTimeout(delay);await new Promise<void>(resolve=>slow.close(()=>resolve()));}
  } finally {
    if(browser)await browser.close();if(child)await stop(child);
    if(adminServer)await new Promise<void>(resolve=>adminServer!.close(()=>resolve()));
    await new Promise<void>(resolve=>fixture.close(()=>resolve()));
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});
  }
});
