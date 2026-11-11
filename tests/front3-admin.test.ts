import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {createAdminServer} from '../apps/admin-auth.js';
import {registerProject} from '../apps/project-registration.js';
import {cleanup} from '../apps/detection.js';

test('Front3: desktop/mobile project registration, atomic audit, navigation and incident filters',{timeout:90000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='front3_admin_'+randomUUID().replaceAll('-','');
 await root.query(`CREATE SCHEMA ${schema}`);const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 let server:ReturnType<typeof createAdminServer>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
  await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL); CREATE TABLE admin_totp_codes(factor_id text,digest text,valid_until bigint,PRIMARY KEY(factor_id,digest))');
  // Force the complementary write to fail: the project must never be committed.
  await db.query("CREATE FUNCTION reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_registration BEFORE INSERT ON project_registration_audit FOR EACH ROW EXECUTE FUNCTION reject_registration()");
  await assert.rejects(registerProject(db,{name:'Must rollback',origin:'https://rollback.test'}));
  assert.equal((await db.query('SELECT count(*)::int n FROM projects')).rows[0].n,0);
  await db.query('DROP TRIGGER reject_registration ON project_registration_audit');
  const secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',salt='0123456789abcdef0123456789abcdef';let clock=Date.now();
  server=createAdminServer(`scrypt$${salt}$${scryptSync('synthetic-password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db,()=>clock).listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  browser=await chromium.launch();
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   const context=await browser.newContext({viewport}),page=await context.newPage();
   await page.goto(base+'/admin/ui/');await page.locator('#login [name=password]').fill('synthetic-password');await page.locator('#login [name=code]').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate({timestamp:clock}));
   const login=page.waitForResponse(r=>r.url().endsWith('/admin/ui/login'));await page.locator('#login button').click();assert.equal((await login).status(),204);
   await page.locator('#settings').waitFor({state:'visible'});await page.locator('#incident-query [name=project]').waitFor();
   const form=page.locator('#project-create');await form.locator('[name=name]').fill('Synthetic '+viewport.width);await form.locator('[name=origin]').fill('https://owner-'+viewport.width+'.test');
   const created=page.waitForResponse(r=>r.url().endsWith('/project-create'));await form.getByRole('button').click();assert.equal((await created).status(),200);
   await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#project-history [name=project]')!.value.length>0);
   const project=await page.locator('#project-history [name=project]').inputValue();
   const audit=page.waitForResponse(r=>r.url().endsWith('/project-history'));await page.locator('#project-history button').click();assert.equal((await audit).status(),200);
   await page.waitForFunction(()=>document.querySelector('#project-audit')!.textContent!.includes('CREATE_PROJECT'));
   assert.equal((await db.query('SELECT actor FROM project_registration_audit WHERE project_id=$1',[project])).rows[0].actor,'AUTHENTICATED_OWNER');
   await db.query("INSERT INTO incidents(project_id,host) VALUES($1,'alpha.clone.test'),($1,'beta.clone.test')",[project]);
   await page.locator('#incident-query [name=project]').selectOption(project);await page.locator('#incident-query [name=hostFilter]').fill('alpha');
   const queried=page.waitForResponse(r=>r.url().endsWith('/incidents'));await page.locator('#incident-query button').click();assert.equal((await queried).status(),200);
   await page.locator('#incident-list h3').waitFor();assert.equal(await page.locator('#incident-list h3').count(),1);assert.match(await page.locator('#incident-list h3').innerText(),/alpha/);
   assert.equal(await page.evaluate(async()=> (await fetch('/admin/ui/project-create',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status),403);
   assert.ok(await page.getByRole('navigation').getByRole('link',{name:'Incidentes',exact:true}).count());
   await page.getByRole('navigation').getByRole('link',{name:'Incidentes',exact:true}).click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
   await mkdir('test-results/front3',{recursive:true});await page.screenshot({path:'test-results/front3/admin-'+viewport.width+'.png',fullPage:true});
   await page.locator('#logout').click();await context.close();clock+=60000;
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM project_registration_audit')).rows[0].n,2);
  const projects=(await db.query('SELECT id FROM projects ORDER BY id')).rows;
  await db.query("UPDATE projects SET name='Changed without values in metadata' WHERE id=$1",[projects[0].id]);
  assert.deepEqual((await db.query("SELECT changed_fields FROM administrative_change_audit WHERE project_id=$1 AND operation='UPDATE' ORDER BY id DESC LIMIT 1",[projects[0].id])).rows[0].changed_fields,['name']);
  await db.query("INSERT INTO administrative_change_audit(project_id,relation_name,operation,reference,changed_fields,transaction_id,occurred_at) VALUES($1,'projects','UPDATE','{}','{}',1,now()-interval '91 days'),($2,'projects','UPDATE','{}','{}',1,now()-interval '91 days')",[projects[0].id,projects[1].id]);
  await cleanup(db,projects[0].id);
  assert.equal((await db.query("SELECT count(*)::int n FROM administrative_change_audit WHERE project_id=$1 AND occurred_at<now()-interval '90 days'",[projects[0].id])).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM administrative_change_audit WHERE project_id=$1 AND occurred_at<now()-interval '90 days'",[projects[1].id])).rows[0].n,1);
 }finally{await browser?.close();if(server?.listening)await new Promise<void>(r=>server!.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
