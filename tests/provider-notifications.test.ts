import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {Socket} from 'node:net';
import {Pool} from 'pg';
import {SMTPServer} from 'smtp-server';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {importInventory,approveDestination,mapPoint} from '../apps/cta-inventory.js';
import {enableInstallation} from '../apps/installation.js';
import {configureHealth} from '../apps/health-alerts.js';
import {managePages} from '../apps/protected-pages.js';
import {notificationAdmin,NotificationReviewConflict} from '../apps/notification-reviews.js';
import {createAdminServer} from '../apps/admin-auth.js';
import {smtpProvider,sendProviderNotice} from '../apps/smtp-provider.js';
import {observe} from '../apps/detection.js';
import {localGatewayMonitor} from '../apps/local-gateway-monitor.js';

async function until(check:()=>Promise<boolean>,label:string){const end=Date.now()+18000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,75));}throw Error('timeout '+label);}
async function stop(child:ChildProcess|undefined,kill=false){if(!child||child.exitCode!==null||child.signalCode!==null)return;const timer=setTimeout(()=>child.kill('SIGKILL'),4000);try{child.kill(kill?'SIGKILL':'SIGTERM');await once(child,'exit');}finally{clearTimeout(timer);}}

test('CTA/health provider TLS + independent worker + audited backlog in Chromium, durable retry and unknown owner',{timeout:180000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='provider_all_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const dir=await mkdtemp(join(tmpdir(),'provider-all-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  let rejectAuth=true,stall=false,logs='',phase='setup';const accepted:string[]=[],sockets=new Set<Socket>();
  const mark=(value:string)=>{phase=value;process.stdout.write('PROVIDER_PHASE '+phase+'\n');};
  const smtp=new SMTPServer({secure:true,key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert')),
    onAuth(auth,_session,callback){if(rejectAuth||auth.username!=='synthetic-user'||auth.password!=='synthetic-private-password'){callback(Error('synthetic rejection'));return;}callback(null,{user:auth.username});},
    onData(stream,_session,callback){let body='';stream.on('data',chunk=>body+=String(chunk));stream.on('end',()=>{if(!stall){accepted.push(body);callback();}});}
  });smtp.on('error',()=>{});smtp.server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));const smtpAddress=smtp.server.address();assert.ok(smtpAddress&&typeof smtpAddress!=='string');
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const reserved=reserve.address();assert.ok(reserved&&typeof reserved!=='string');const port=reserved.port;await new Promise<void>(r=>reserve.close(()=>r()));
  const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<h1>Owned original/copy</h1><a href="/native">Native checkout</a><script async src="http://127.0.0.1:${port}/runtime.js"></script>`)).listen(0,'127.0.0.1');await once(site,'listening');const address=site.address();assert.ok(address&&typeof address!=='string');
  const original='http://127.0.0.1:'+address.port,copy='http://localhost:'+address.port;
  const privateEnv={SMTP_PROVIDER:'smtp',SMTP_HOST:'localhost',SMTP_PORT:String(smtpAddress.port),SMTP_TLS:'implicit',SMTP_SENDER:'sender@example.test',SMTP_RECIPIENT:'owner@example.test',SMTP_USER:'synthetic-user',SMTP_PASSWORD:'synthetic-private-password'};
  const env={...process.env,...privateEnv,NODE_EXTRA_CA_CERTS:join(dir,'cert'),DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,PROJECT_ID:'one',PORT:String(port),ALLOWED_ORIGIN:original};
  let gateway:ChildProcess|undefined,worker:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,admin:ReturnType<typeof createServer>|undefined;
  const launch=(file:string,extra:Record<string,string>={})=>{const child=spawn(process.execPath,['dist/apps/'+file],{env:{...env,...extra},stdio:['ignore','ignore','pipe']});child.stderr!.on('data',chunk=>logs+=String(chunk));return child;};
  const startGateway=async()=>{gateway=launch('server.js');await until(async()=>{try{return(await fetch('http://127.0.0.1:'+port+'/healthz')).ok;}catch{return false;}},'real gateway ready');};
  const startWorker=()=>worker=launch('cta-delivery-worker.js',{NOTIFICATION_WORKER_MODE:'PROVIDER',MONITOR_LOCAL_GATEWAY:'1',MONITOR_GATEWAY_PORT:String(port)});
  const inventory=(first:string,second:string)=>importInventory(db,'one',{surface:'main',candidates:[{marker:'checkout01',kind:'a',parent:'div',ordinal:1,url:original+first},{marker:'checkout02',kind:'a',parent:'div',ordinal:2,url:original+second}]});
  try{
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    // createAdminServer is embedded here; reproduce admin-server's durable MFA setup.
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id,digest))');
    mark('migrated');
    await db.query("INSERT INTO projects(id,name,origin) VALUES('one','One',$1),('two','Two','https://other.test')",[original]);
    await enableInstallation(db,'one');await enableInstallation(db,'two');await configureHealth(db,'one',false,60,true);
    await managePages(db,{action:'create',project:'one',name:'Controlled notification LP',url:original+'/'});
    await db.query('UPDATE notification_settings SET provider=$1,host=$2,port=$3,tls_mode=$4,sender=$5,recipient=$6,requested=false',[privateEnv.SMTP_PROVIDER,privateEnv.SMTP_HOST,smtpAddress.port,privateEnv.SMTP_TLS,privateEnv.SMTP_SENDER,privateEnv.SMTP_RECIPIENT]);
    const provider=smtpProvider(privateEnv)!;await assert.rejects(sendProviderNotice(provider,'cta-999','Synthetic notice','Controlled test'));
    mark('strict TLS rejection');
    await inventory('/native-one','/native-two');
    for(const [marker,offer] of [['checkout01','basic'],['checkout02','premium']]){
      const point=(await db.query('SELECT id FROM cta_points WHERE marker=$1',[marker])).rows[0];const destination=await approveDestination(db,'one',{offer,url:original+'/official-'+offer});await mapPoint(db,'one',{pointId:point.id,offer,destinationId:destination.id});
    }
    await inventory('/changed-one','/native-two');await inventory('/changed-one','/native-two');
    assert.equal((await db.query('SELECT count(*)::int n FROM cta_drift_alerts')).rows[0].n,1);
    mark('inventory and drift');
    await startGateway();browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});const page=await browser.newPage();page.setDefaultTimeout(10000);
    await page.goto(original);await page.waitForTimeout(250);assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,0);assert.equal(await page.getByRole('link').getAttribute('href'),'/native');
    await page.goto(copy);await until(async()=>(await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n===1,'copy incident');await page.reload();
    await stop(gateway);gateway=undefined;assert.equal(accepted.length,0);
    mark('original and copy');
    await managePages(db,{project:'one',action:'pause-project'});await managePages(db,{project:'one',action:'resume-project'});
    const held=await notificationAdmin(db,{action:'inspect',project:'one'});assert.equal(held.items.length,2);assert.equal((await notificationAdmin(db,{action:'inspect',project:'two'})).items.length,0);
    mark('held backlog');
    const salt='0123456789abcdef0123456789abcdef',secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    admin=createAdminServer(`scrypt$${salt}$${scryptSync('review password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(admin,'listening');const adminAddress=admin.address();assert.ok(adminAddress&&typeof adminAddress!=='string');const adminBase='http://127.0.0.1:'+adminAddress.port;
    await page.goto(adminBase+'/admin/ui/');await page.getByLabel('Senha administrativa').fill('review password');await page.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());
    const logged=page.waitForResponse(r=>r.url().endsWith('/admin/ui/login'));await page.getByRole('button',{name:'Entrar',exact:true}).click();assert.equal((await logged).status(),204);
    assert.equal(await page.evaluate(async()=> (await fetch('/admin/ui/notifications',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"inspect","project":"one"}'})).status),403);
    mark('MFA CSRF');
    const form=page.locator('#backlog-form');await form.locator('[name=project]').fill('one');
    const submit=async(action:string)=>{const response=page.waitForResponse(r=>r.url().endsWith('/admin/ui/notifications'));await form.locator('button[value="'+action+'"]').click();return response;};
    assert.equal((await submit('inspect')).status(),200);
    const cta=held.items.find(r=>r.queue==='CTA')!,clone=held.items.find(r=>r.queue==='CLONE')!;
    await form.locator('[name=heldItem]').selectOption('CTA:'+cta.item_id);await form.locator('[name=reason]').fill('Synthetic reviewed fresh change');await form.locator('[name=confirmation]').fill('wrong');await form.locator('[name=ack]').check();assert.equal((await submit('RELEASE')).status(),400);
    await form.locator('[name=confirmation]').fill('CTA:'+cta.item_id);assert.equal((await submit('RELEASE')).status(),200);
    await page.waitForFunction(()=>![...document.querySelector<HTMLSelectElement>('#backlog-form [name=heldItem]')!.options].some(o=>o.value.startsWith('CTA:')));
    await assert.rejects(notificationAdmin(db,{action:'RELEASE',project:'one',queue:'CTA',item:cta.item_id,revision:cta.revision,reason:'stale request',confirmation:'CTA:'+cta.item_id,acknowledgeDuplicateRisk:true}),NotificationReviewConflict);
    await form.locator('[name=heldItem]').selectOption('CLONE:'+clone.item_id);await form.locator('[name=reason]').fill('Synthetic cancelled future notification');await form.locator('[name=confirmation]').fill('CLONE:'+clone.item_id);assert.equal((await submit('CANCEL')).status(),200);
    assert.equal((await db.query('SELECT attempts FROM alert_outbox')).rows[0].attempts,0);assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,1);
    mark('review release cancel');
    await db.query('UPDATE notification_settings SET requested=true');startWorker();
    await until(async()=>(await db.query("SELECT count(*)::int n FROM cta_delivery_attempts WHERE outcome='FAILED'")).rows[0].n===1&&(await db.query("SELECT count(*)::int n FROM health_delivery_attempts WHERE outcome='FAILED'")).rows[0].n===1,'CTA/health failures durable');
    await stop(worker);worker=undefined;assert.equal(accepted.length,0);
    mark('provider failures persisted');
    rejectAuth=false;await db.query('UPDATE cta_alert_deliveries SET next_attempt=clock_timestamp()');await db.query('UPDATE health_delivery SET next_attempt=clock_timestamp()');startWorker();
    await until(async()=>(await db.query("SELECT count(*)::int n FROM cta_alert_deliveries WHERE result_kind='SMTP_PROVIDER_ACCEPTED'")).rows[0].n===1&&(await db.query('SELECT count(*)::int n FROM health_delivery WHERE sent_at IS NOT NULL')).rows[0].n===1,'retry accepted');
    assert.equal(accepted.length,2);assert.ok(accepted.some(m=>m.includes('gateway_local')));assert.ok(accepted.some(m=>/Message-ID: <anticlone-cta-/.test(m)));
    mark('provider retry accepted');
    await stop(worker);worker=undefined;startWorker();await page.waitForTimeout(1500);assert.equal(accepted.length,2,'restart does not duplicate completed notices');await stop(worker);worker=undefined;
    await startGateway();startWorker();await until(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='gateway_local' AND recovered_at IS NOT NULL")).rows[0].n===1,'actual local gateway recovery');await stop(worker);worker=undefined;
    await stop(gateway);gateway=undefined;startWorker();await until(async()=>(await db.query("SELECT count(*)::int n FROM health_episodes WHERE source='gateway_local'")).rows[0].n===2&&accepted.length===3,'new real outage notified once');await stop(worker);worker=undefined;
    mark('gateway restart recovery and new outage');
    stall=true;await inventory('/changed-one','/changed-two');startWorker();
    await until(async()=>(await db.query("SELECT count(*)::int n FROM cta_alert_deliveries WHERE state='PROCESSING'")).rows[0].n===1,'live CTA admission');await stop(worker,true);worker=undefined;stall=false;
    await db.query("UPDATE cta_alert_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE state='PROCESSING'");const before=(await db.query("SELECT * FROM cta_alert_deliveries WHERE state='PROCESSING'")).rows[0];
    startWorker();await page.waitForTimeout(1200);await stop(worker);worker=undefined;
    const unknown=(await notificationAdmin(db,{action:'inspect',project:'one'})).items.find(r=>r.hold_state==='OUTCOME_UNKNOWN')!;assert.ok(unknown);
    const decision={project:'one',queue:'CTA',item:unknown.item_id,revision:unknown.revision,reason:'Synthetic transport outcome cannot be established',confirmation:'CTA:'+unknown.item_id,acknowledgeDuplicateRisk:true};
    await assert.rejects(notificationAdmin(db,{...decision,action:'RELEASE'}),NotificationReviewConflict);await assert.rejects(notificationAdmin(db,{...decision,action:'CANCEL'}),NotificationReviewConflict);await notificationAdmin(db,{...decision,action:'ACK_UNKNOWN'});
    const after=(await db.query('SELECT * FROM cta_alert_deliveries WHERE alert_id=$1',[before.alert_id])).rows[0];assert.equal(after.lease_token,before.lease_token);assert.equal(after.attempts,1);assert.equal(after.state,'PROCESSING');assert.equal(accepted.length,3);
    const result=await notificationAdmin(db,{action:'inspect',project:'one'});assert.equal(result.mailbox_delivery,'UNVERIFIED');assert.ok(result.history.some(r=>r.decision==='ACK_UNKNOWN'));assert.equal((await notificationAdmin(db,{action:'inspect',project:'two'})).attempts.length,0);
    assert.ok(!logs.includes(privateEnv.SMTP_PASSWORD)&&!logs.includes(privateEnv.SMTP_USER),'provider failures never log credentials');
    process.stdout.write('PROVIDER_NOTIFICATIONS '+JSON.stringify({smtp_acceptances:accepted.length,cta:result.attempts.filter(r=>r.queue==='CTA'),health:result.attempts.filter(r=>r.queue==='HEALTH'),reviews:result.history.map(r=>r.decision)})+'\n');
  }catch(error){process.stdout.write('PROVIDER_FAILURE '+phase+' '+String(error)+'\n');throw error;}
  finally{await stop(worker);await stop(gateway);if(browser)await browser.close();if(admin){admin.closeAllConnections();await new Promise<void>(r=>admin!.close(()=>r()));}site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));for(const socket of sockets)socket.destroy();await new Promise<void>(r=>smtp.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});}
});

test('provider worker isolates failing queues/projects, respects paused monitor generations and stops new admissions',{timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='worker_isolation_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`}),dir=await mkdtemp(join(tmpdir(),'worker-isolation-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const messages:string[]=[],sockets=new Set<Socket>();let hold=false,release:(()=>void)|undefined,logs='',healthy=false;
  const smtp=new SMTPServer({secure:true,key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert')),onAuth(_auth,_session,cb){cb(null,{user:'synthetic'});},onData(stream,_session,cb){let text='';stream.on('data',c=>text+=String(c));stream.on('end',()=>{const done=()=>{messages.push(text);cb();};if(hold){hold=false;release=done;}else done();});}});
  smtp.on('error',()=>{});smtp.server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise<void>(r=>smtp.listen(0,'127.0.0.1',r));const smtpAddr=smtp.server.address();assert.ok(smtpAddr&&typeof smtpAddr!=='string');
  const backend=createServer((_req,res)=>res.writeHead(healthy?200:503,{'content-type':'application/json'}).end(JSON.stringify({status:'ready',mode:'LAB',action:'OBSERVE_ONLY'}))).listen(0,'127.0.0.1');await once(backend,'listening');const backendAddr=backend.address();assert.ok(backendAddr&&typeof backendAddr!=='string');
  const env={...process.env,PROJECT_ID:undefined,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,SMTP_PROVIDER:'smtp',SMTP_HOST:'localhost',SMTP_PORT:String(smtpAddr.port),SMTP_TLS:'implicit',SMTP_USER:'synthetic-user',SMTP_PASSWORD:'synthetic-private-password',SMTP_SENDER:'sender@example.test',SMTP_RECIPIENT:'owner@example.test',NODE_EXTRA_CA_CERTS:join(dir,'cert'),NOTIFICATION_WORKER_MODE:'PROVIDER',MONITOR_LOCAL_GATEWAY:'1',MONITOR_GATEWAY_PORT:String(backendAddr.port)};
  let worker:ChildProcess|undefined;
  const start=()=>{worker=spawn(process.execPath,['dist/apps/cta-delivery-worker.js'],{env,stdio:['ignore','ignore','pipe']});worker.stderr!.on('data',chunk=>logs+=String(chunk));};
  const inventory=(suffix:string)=>importInventory(db,'a',{surface:'main',candidates:[{marker:'checkout01',kind:'a',parent:'div',ordinal:1,url:'https://owner-a.test/'+suffix}]});
  try{
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('a','A','https://owner-a.test'),('b','B','https://owner-b.test')");
    for(const id of ['a','b']){await enableInstallation(db,id);await configureHealth(db,id,false,60,true);await observe(db,id,[],'https://copy-'+id+'.test','core');}
    await db.query("UPDATE notification_settings SET provider='smtp',host='localhost',port=$1,tls_mode='implicit',sender='sender@example.test',recipient='owner@example.test',requested=true",[smtpAddr.port]);
    await inventory('native');const point=(await db.query("SELECT id FROM cta_points WHERE project_id='a'")).rows[0];const destination=await approveDestination(db,'a',{offer:'offer',url:'https://owner-a.test/official'});await mapPoint(db,'a',{pointId:point.id,offer:'offer',destinationId:destination.id});await inventory('changed');
    await db.query(`CREATE FUNCTION fail_a_clone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM incidents WHERE id=NEW.incident_id AND project_id='a') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='controlled project fault'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER fail_a_clone BEFORE UPDATE ON alert_outbox FOR EACH ROW EXECUTE FUNCTION fail_a_clone();
      CREATE FUNCTION fail_a_monitor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='a' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='controlled monitor fault'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER fail_a_monitor BEFORE INSERT ON health_episodes FOR EACH ROW EXECUTE FUNCTION fail_a_monitor();`);
    start();await until(async()=>(await db.query("SELECT count(*)::int n FROM cta_alert_deliveries WHERE result_kind='SMTP_PROVIDER_ACCEPTED'")).rows[0].n===1&&(await db.query("SELECT count(*)::int n FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='b' AND a.sent_at IS NOT NULL")).rows[0].n===1&&(await db.query("SELECT count(*)::int n FROM health_delivery WHERE sent_at IS NOT NULL")).rows[0].n===1,'failed A clone/monitor do not block A CTA or B deliveries');
    assert.equal(messages.length,3);assert.equal((await db.query("SELECT a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id='a'")).rows[0].attempts,0);
    await stop(worker);worker=undefined;assert.ok(logs.includes('CLONE maintenance failed')&&logs.includes('local monitor project persistence failed'));
    await db.query('DROP TRIGGER fail_a_clone ON alert_outbox;DROP FUNCTION fail_a_clone();DROP TRIGGER fail_a_monitor ON health_episodes;DROP FUNCTION fail_a_monitor()');
    let clock=1000000;healthy=true;const monitor=localGatewayMonitor(db,{MONITOR_LOCAL_GATEWAY:'1',MONITOR_GATEWAY_PORT:String(backendAddr.port),PROJECT_ID:'a'},()=>clock);
    await monitor();await managePages(db,{action:'pause-project',project:'a'});healthy=false;clock+=60000;await monitor();healthy=true;await managePages(db,{action:'resume-project',project:'a'});clock+=60000;await monitor();assert.equal((await db.query("SELECT count(*)::int n FROM health_episodes WHERE project_id='a' AND source='gateway_local'")).rows[0].n,0,'no retroactive paused-period observation');
    // Resume holds A's old pending clone. Explicitly release it, then prepare
    // later jobs which must remain untouched when SIGTERM interrupts the sweep.
    const held=(await notificationAdmin(db,{action:'inspect',project:'a'})).items.find(r=>r.queue==='CLONE')!;
    await notificationAdmin(db,{action:'RELEASE',project:'a',queue:'CLONE',item:held.item_id,revision:held.revision,reason:'Controlled reviewed pending event',confirmation:'CLONE:'+held.item_id,acknowledgeDuplicateRisk:true});
    await importInventory(db,'a',{surface:'second',candidates:[{marker:'checkout02',kind:'a',parent:'div',ordinal:1,url:'https://owner-a.test/native-two'}]});
    const p2=(await db.query("SELECT id FROM cta_points WHERE marker='checkout02'")).rows[0];await mapPoint(db,'a',{pointId:p2.id,offer:'offer',destinationId:destination.id});await importInventory(db,'a',{surface:'second',candidates:[{marker:'checkout02',kind:'a',parent:'div',ordinal:1,url:'https://owner-a.test/changed-two'}]});
    await observe(db,'b',[],'https://new-copy-b.test','core');hold=true;start();await until(async()=>!!release,'current SMTP admission held');const offset=logs.length;const exited=once(worker!,'exit');worker!.kill('SIGTERM');await until(async()=>logs.slice(offset).includes('worker stopping'),'worker has observed shutdown');release!();await exited;worker=undefined;
    assert.equal(messages.length,4);assert.equal((await db.query("SELECT d.attempts FROM cta_alert_deliveries d JOIN cta_drift_alerts a ON a.id=d.alert_id WHERE a.point_id=$1",[p2.id])).rows[0].attempts,0,'no subsequent queue admission after SIGTERM');assert.equal((await db.query("SELECT a.attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.host='new-copy-b.test'")).rows[0].attempts,0,'no subsequent project admission');
  }finally{release?.();await stop(worker);backend.closeAllConnections();await new Promise<void>(r=>backend.close(()=>r()));for(const socket of sockets)socket.destroy();await new Promise<void>(r=>smtp.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(dir,{recursive:true,force:true});}
});
