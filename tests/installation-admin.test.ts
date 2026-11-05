import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { chromium } from 'playwright';
import { createAdminServer } from '../apps/admin-auth.js';
import { enableInstallation, InstallationOriginConflict, recordInstallationClaim } from '../apps/installation.js';

test('installation admin: authentication, session separation, CSRF, expiry and origin conflict', {timeout:60000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='install_admin_'+crypto.randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let clock=1000000000;
  const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
  const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const totp=new TOTP({secret:Secret.fromBase32(secret)});
  const server=createAdminServer(record,secret,db,()=>clock).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser=await chromium.launch();
  const api=(method:string,suffix='',headers:Record<string,string>={})=>fetch(base+'/admin/projects/one/installation'+suffix,{method,headers});
  const ui=(action:string,headers:Record<string,string>={})=>fetch(base+'/admin/ui/installation'+action,{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:'{"project":"one"}'});
  const snapshot=async()=>({installations:(await db.query('SELECT * FROM installations ORDER BY project_id')).rows,signals:(await db.query('SELECT * FROM installation_signals ORDER BY project_id,source')).rows});
  try {
    for (const file of ['003_projects','025_installation_signals']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query('CREATE TABLE admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
    await db.query('CREATE TABLE admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id,digest))');
    await db.query("INSERT INTO projects VALUES('one','One','http://owner.test')");
    await enableInstallation(db,'one');
    await db.query("INSERT INTO installation_signals(project_id,source) VALUES('one','core')");
    const initial=await snapshot();
    for (const [method,suffix] of [['GET',''],['POST',''],['POST','/disable']]) {
      assert.equal((await api(method,suffix)).status,401);
      assert.equal((await api(method,suffix,{authorization:'Bearer '+'0'.repeat(64)})).status,401);
    }
    const login=await fetch(base+'/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:totp.generate({timestamp:clock})})});
    assert.equal(login.status,200);
    const {token}=await login.json() as {token:string};
    const bearer={authorization:`Bearer ${token}`};
    for (const [method,suffix] of [['GET',''],['POST',''],['POST','/disable']]) {
      for (const boundary of [{origin:base},{'sec-fetch-site':'cross-site'}] as Record<string,string>[]) assert.equal((await api(method,suffix,{...bearer,...boundary})).status,403);
      assert.equal((await api(method,suffix,{cookie:`admin_session=${token}`})).status,401);
    }
    assert.equal((await api('GET','',bearer)).status,200);
    for (const action of ['','-enable','-disable']) {
      assert.equal((await ui(action)).status,403);
      assert.equal((await ui(action,{cookie:`admin_session=${token}`,'x-csrf-token':token})).status,403);
    }
    assert.deepEqual(await snapshot(),initial);
    clock+=15*60_000;
    for (const [method,suffix] of [['GET',''],['POST',''],['POST','/disable']]) assert.equal((await api(method,suffix,bearer)).status,401);
    const context=await browser.newContext(),page=await context.newPage();
    await page.goto(base+'/admin/ui/');
    await page.getByLabel('Senha administrativa').fill('password');
    await page.getByLabel('Código TOTP').fill(totp.generate({timestamp:clock}));
    await page.getByRole('button',{name:'Entrar',exact:true}).click();
    await page.locator('#installation-form').waitFor();
    const cookie=(await context.cookies()).find(c=>c.name==='admin_session'); assert.ok(cookie);
    const bootstrap=await fetch(base+'/admin/ui/bootstrap',{headers:{'sec-fetch-site':'same-origin',cookie:`admin_session=${cookie.value}`}});
    const {csrf}=await bootstrap.json() as {csrf:string};
    const web={cookie:`admin_session=${cookie.value}`,'x-csrf-token':csrf};
    for (const action of ['','-enable','-disable']) {
      const beforeRejected=await snapshot();
      for (const invalid of [{'x-csrf-token':''},{'x-csrf-token':'bad'},{origin:'http://evil.test'},{'sec-fetch-site':'cross-site'},{cookie:''},{'content-type':'text/plain'}] as Record<string,string>[]) assert.equal((await ui(action,{...web,...invalid})).status,403);
      assert.deepEqual(await snapshot(),beforeRejected);
      assert.equal((await ui(action,web)).status,200);
    }
    assert.equal((await api('GET','',{authorization:`Bearer ${cookie.value}`})).status,401);
    assert.equal((await ui('-enable',web)).status,200);
    await db.query("UPDATE projects SET origin='http://changed.test' WHERE id='one'");
    const beforeConflict=await snapshot();
    await assert.rejects(enableInstallation(db,'one'),InstallationOriginConflict);
    await recordInstallationClaim(db,'one','http://owner.test','core');
    await recordInstallationClaim(db,'one','http://changed.test','core');
    assert.equal((await ui('-enable',web)).status,409);
    await page.locator('#installation-form input[name=project]').fill('one');
    await page.locator('#installation-enable').click();
    await page.getByText('A origem do projeto mudou.',{exact:false}).waitFor();
    assert.deepEqual(await snapshot(),beforeConflict);
    const diagnostic=await (await ui('',web)).json();
    assert.equal(diagnostic.status,'NOT_VERIFIED'); assert.equal(diagnostic.installation.originMatches,false);
    clock+=15*60_000;
    for (const action of ['','-enable','-disable']) assert.equal((await ui(action,web)).status,403);
    assert.deepEqual(await snapshot(),beforeConflict);
    // A fresh bearer session also reports the same explicit conflict.
    const fresh=await fetch(base+'/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:totp.generate({timestamp:clock})})});
    assert.equal(fresh.status,200); const next=await fresh.json() as {token:string};
    assert.equal((await api('POST','',{authorization:`Bearer ${next.token}`})).status,409);
    assert.deepEqual(await snapshot(),beforeConflict);
  } finally {
    await browser.close(); server.close(); await once(server,'close');
    await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end();
  }
});
