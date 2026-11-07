import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { randomUUID, scryptSync } from 'node:crypto';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { chromium } from 'playwright';
import { backup, restore, postgresTool, type Tool } from '../apps/recovery.js';
import { createAdminServer } from '../apps/admin-auth.js';
import { classifyIncident } from '../apps/incident-triage.js';
import { observe } from '../apps/detection.js';
import { recordCheckout } from '../apps/checkout-webhook.js';

// Optional local Windows adapter: executes the same PostgreSQL binaries in the
// existing isolated lab container. CI exercises the default native tool runner.
const localTool: Tool = async (name,args,env,file) => {
  const container=process.env.RECOVERY_TEST_CONTAINER!;
  assert.match(container,/^anticlone-[a-z0-9-]+$/);
  const command=['-d','Ubuntu','--','docker','exec','-i',container,name,'--username='+env.PGUSER];
  const rest=args.filter(value=>value!==file);
  if(name==='pg_dump') rest.push('--dbname='+env.PGDATABASE);
  const child=spawn('wsl.exe',[...command,...rest],{stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const finished=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('local PostgreSQL tool failed')));});
  const transfer=name==='pg_dump'?pipeline(child.stdout,createWriteStream(file,{flags:'wx',mode:0o600})):pipeline(createReadStream(file),child.stdin);
  await Promise.all([finished,transfer]);
};

test('GS16: real backup, isolated restore, complete data integrity and restarted pilot/admin', {timeout:120000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL required');
  const suffix=randomUUID().replaceAll('-','').slice(0,16);
  const sourceName='anticlone_recovery_'+suffix, targetName='anticlone_restore_'+suffix;
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await root.query(`CREATE DATABASE ${sourceName}`); await root.query(`CREATE DATABASE ${targetName}`);
  const occupiedName=targetName+'_occupied';await root.query(`CREATE DATABASE ${occupiedName}`);
  const url=(name:string)=>{const value=new URL(process.env.TEST_DATABASE_URL!);value.pathname='/'+name;return value.href;};
  const sourceUrl=url(sourceName),targetUrl=url(targetName);
  const source=new Pool({connectionString:sourceUrl}),target=new Pool({connectionString:targetUrl});
  const directory=join(await mkdtemp(join(tmpdir(),'anticlone-recovery-')),'backup');
  const tool=process.env.RECOVERY_TEST_CONTAINER?localTool:postgresTool;
  let gateway:ChildProcess|undefined,adminProcess:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let admin:ReturnType<typeof createAdminServer>|undefined;
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';let clock=Date.now();
  const token=new TOTP({secret:Secret.fromBase32(secret)}).generate({timestamp:clock});
  const salt='0123456789abcdef0123456789abcdef';
  const record=`scrypt$${salt}$${scryptSync('synthetic-password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const startAdmin=async(db:Pool)=>{const server=createAdminServer(record,secret,db,()=>clock).listen(0,'127.0.0.1');await once(server,'listening');return server;};
  const address=(server:ReturnType<typeof createAdminServer>)=>{const value=server.address();assert.ok(value&&typeof value!=='string');return `http://127.0.0.1:${value.port}`;};
  const login=(base:string,code=token)=>fetch(base+'/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-password',code})});
  const stop=async(child:ChildProcess)=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await once(child,'exit');};
  try {
    const files=(await readdir('infra')).filter(file=>/^\d{3}_.+\.sql$/.test(file)).sort();
    assert.ok(files.length>=32);
    for(const file of files) await source.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await source.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY,last_counter bigint NOT NULL)');
    await source.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    await source.query("INSERT INTO projects VALUES('recovery','Synthetic owner','https://owner.test'),('second','Second owner','https://second.test')");
    await observe(source,'recovery','https://owner.test','https://copy.test');
    const incident=(await source.query("SELECT id FROM incidents WHERE project_id='recovery'")).rows[0].id as string;
    await classifyIncident(source,{project:'recovery',host:'copy.test',incident_id:incident,version:'0',expected:'unverified',status:'investigating',justification:'Synthetic recovery exercise'});
    await source.query("INSERT INTO protection_policy_versions(project_id,version,enabled,approved_destination,stealth,allocation) VALUES('recovery',1,true,'https://owner.test/approved',true,'{\"PAID_ATTRIBUTED\":100,\"ORGANIC\":50,\"REFERRAL\":0,\"DIRECT_UNKNOWN\":0}')");
    await source.query("INSERT INTO active_protection_policies VALUES('recovery',1)");
    await source.query("UPDATE notification_settings SET version=1,provider='smtp',host='smtp.test',port=587,tls_mode='starttls',sender='owner@example.test',recipient='owner@example.test'");
    await source.query("INSERT INTO notification_settings_audit(version,action,changed_fields) VALUES(1,'save',ARRAY['provider'])");
    await source.query('UPDATE alert_outbox SET attempts=1,next_attempt=now()+interval \'1 hour\'');
    await source.query("INSERT INTO clone_delivery_attempts(outbox_id,attempt,transport,outcome,finished_at) SELECT id,1,'SMTP_LOCAL','FAILED',clock_timestamp() FROM alert_outbox");
    await recordCheckout(source,'recovery',Buffer.from(JSON.stringify({event_id:'recovery_event',sale_id:'recovery_sale',amount_minor:1999,currency:'BRL',occurred_at:'2026-11-06T00:00:00.000Z'})));
    admin=await startAdmin(source);
    assert.equal((await login(address(admin))).status,200);
    admin.close();await once(admin,'close');admin=undefined;
    // Close the writer pool before taking a consistent snapshot and recovering.
    const manifest=await backup(sourceUrl,directory,tool);
    assert.ok(manifest.tables.some(table=>table.name==='incident_status_audit'&&table.rows===1));
    assert.ok(manifest.tables.some(table=>table.name==='admin_totp_replay'&&table.rows===1));
    for(const name of ['clone_delivery_attempts','checkout_sales','checkout_receipts']) assert.ok(manifest.tables.some(table=>table.name===name&&table.rows===1));
    await assert.rejects(backup(sourceUrl,directory,tool));
    await assert.rejects(restore(sourceUrl,directory,sourceName,tool),/isolated/);
    await assert.rejects(restore(targetUrl,directory,'wrong-confirmation',tool),/isolated/);
    const occupied=new Pool({connectionString:url(occupiedName)});
    await occupied.query("CREATE TYPE public.preexisting AS ENUM('synthetic')");await occupied.end();
    await assert.rejects(restore(url(occupiedName),directory,occupiedName,tool),/empty and offline/);
    await target.query('SELECT 1');
    await assert.rejects(restore(targetUrl,directory,targetName,tool),/empty and offline/);
    // No live target sessions may coexist with restore.
    await target.end();
    assert.ok((await restore(targetUrl,directory,targetName,tool)).verified);
    await assert.rejects(restore(targetUrl,directory,targetName,tool),/empty and offline/);
    const restored=new Pool({connectionString:targetUrl});
    try {
      assert.equal((await restored.query('SELECT count(*)::int n FROM projects')).rows[0].n,2);
      assert.equal((await restored.query('SELECT status FROM incidents')).rows[0].status,'investigating');
      assert.equal((await restored.query('SELECT attempts FROM alert_outbox')).rows[0].attempts,1);
      assert.deepEqual((await restored.query('SELECT attempt,transport,outcome FROM clone_delivery_attempts')).rows,[{attempt:1,transport:'SMTP_LOCAL',outcome:'FAILED'}]);
      assert.deepEqual((await restored.query('SELECT project_id,sale_id,amount_minor,currency,attribution FROM checkout_sales')).rows,[{project_id:'recovery',sale_id:'recovery_sale',amount_minor:'1999',currency:'BRL',attribution:'UNVERIFIED'}]);
      assert.equal((await restored.query('SELECT event_id FROM checkout_receipts')).rows[0].event_id,'recovery_event');
      assert.equal((await recordCheckout(restored,'recovery',Buffer.from(JSON.stringify({event_id:'recovery_event',sale_id:'recovery_sale',amount_minor:1999,currency:'BRL',occurred_at:'2026-11-06T00:00:00.000Z'})))).duplicate,true);
      // Identity sequence must advance beyond the restored incident ID.
      const next=await restored.query("INSERT INTO incidents(project_id,host) VALUES('second','copy.test') RETURNING id");
      assert.ok(BigInt(next.rows[0].id)>BigInt(incident));
      admin=await startAdmin(restored);
      assert.equal((await login(address(admin))).status,401,'restored TOTP must reject replay after restart');
      assert.equal((await fetch(address(admin)+'/admin/projects')).status,401);
      clock+=30000;
      const fresh=await login(address(admin),new TOTP({secret:Secret.fromBase32(secret)}).generate({timestamp:clock}));
      assert.equal(fresh.status,200);
      const session=await fresh.json() as {token:string};
      const projects=await fetch(address(admin)+'/admin/projects',{headers:{authorization:'Bearer '+session.token}});
      assert.equal(projects.status,200);assert.equal((await projects.json() as unknown[]).length,2);
      browser=await chromium.launch();
      const page=await browser.newPage();
      await page.goto(address(admin)+'/admin/ui/');
      await page.locator('input[name="password"]').waitFor();
      assert.equal(await page.locator('form#login').count(),1);
      // Start/restart the real gateway against recovered data in pilot mode.
      for(let restart=0;restart<2;restart++) {
        gateway=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:targetUrl,PGOPTIONS:'',PROJECT_ID:'recovery',PORT:'3097',SMTP_PORT:'1',GATEWAY_MODE:'PILOT_OBSERVE',PILOT_ORIGINS:'["https://owner.test"]',ALLOWED_ORIGIN:'',LAB_CONTROLLED_ORIGIN:'',LAB_CONTROLLED_RISK:'',INFRASTRUCTURE_DNS_ENABLED:''},stdio:'ignore'});
        let ready=false;
        for(let retry=0;retry<100&&!ready;retry++){try{ready=(await fetch('http://127.0.0.1:3097/runtime.js')).ok;}catch{/* startup */}if(!ready)await new Promise(resolve=>setTimeout(resolve,50));}
        assert.ok(ready,'recovered gateway starts');
        const response=await fetch('http://127.0.0.1:3097/entry-decision',{method:'POST',headers:{origin:'https://copy.test','content-type':'text/plain'},body:JSON.stringify({session:'a'.repeat(32),signals:{medium:'cpc'}})});
        assert.deepEqual(await response.json(),{action:'OBSERVE_ONLY'});
        await stop(gateway);gateway=undefined;
      }
      admin.close();await once(admin,'close');admin=undefined;
      for(let restart=0;restart<2;restart++) {
        adminProcess=spawn(process.execPath,['dist/apps/admin-server.js'],{env:{...process.env,DATABASE_URL:targetUrl,PGOPTIONS:'',ADMIN_PORT:'3098',ADMIN_PASSWORD_RECORD:record,ADMIN_TOTP_SECRET:secret},stdio:'ignore'});
        let ready=false;
        for(let retry=0;retry<100&&!ready;retry++){try{ready=(await fetch('http://127.0.0.1:3098/admin/ui/')).ok;}catch{/* startup */}if(!ready)await new Promise(resolve=>setTimeout(resolve,50));}
        assert.ok(ready,'recovered administrator process starts');
        assert.equal((await login('http://127.0.0.1:3098')).status,401,'real restarted process preserves replay rejection');
        await page.goto('http://127.0.0.1:3098/admin/ui/');await page.locator('input[name="password"]').waitFor();
        await stop(adminProcess);adminProcess=undefined;
      }
    } finally {if(admin){admin.close();await once(admin,'close');admin=undefined;}await restored.end();}
    const corrupted=directory+'-corrupted';await mkdir(corrupted,{mode:0o700});
    await writeFile(join(corrupted,'manifest.json'),await readFile(join(directory,'manifest.json')),{mode:0o600});
    await writeFile(join(corrupted,'database.dump'),Buffer.from('corrupted synthetic archive'),{mode:0o600});
    await assert.rejects(restore(targetUrl,corrupted,targetName,tool),/integrity/);
  } finally {
    if(gateway)await stop(gateway);
    if(adminProcess)await stop(adminProcess);
    if(admin){admin.close();await once(admin,'close');}
    await browser?.close();await source.end();if(!target.ended)await target.end();await root.end();
    // Dedicated synthetic DBs and private recovery artifact remain for inspection;
    // no database deletion or destructive restore is performed by this exercise.
  }
});
