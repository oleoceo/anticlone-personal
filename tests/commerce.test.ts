import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,scryptSync} from 'node:crypto';
import {readFile,mkdtemp,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {commerceAdmin,commerceWebhook,provisionCommerceSender,CommerceConflict} from '../apps/commerce.js';
import {mapping,moneyMinor,normalize,sampleShape} from '../apps/commerce-mapping.js';
import {createAdminServer} from '../apps/admin-auth.js';

const config={auth:'HMAC_SHA256_TIMESTAMP',fields:{event:'event',order:'order',amount:'amount',currency:'currency',status:'status',occurred:'occurred',product:'product',offer:'offer',checkout:'checkout'},statuses:{paid:'PAID',pending:'PENDING',cancelled:'CANCELLED',refunded:'REFUNDED',chargeback:'CHARGEBACK'},money:{unit:'DECIMAL',exponent:2}};
const sample={event:'e1',order:'order1',amount:'19.99',currency:'BRL',status:'paid',occurred:'2026-11-12T00:00:00.000Z',product:'p1',offer:'o1',checkout:'c1'};
test('Custom mapping rejects expressions, floating money, invalid dates and unsupported authentication',()=>{
 assert.equal(normalize(mapping(config),sample).amount,1999);
 assert.equal(moneyMinor('0.01','DECIMAL',2),1);
 assert.equal(moneyMinor('1234567890.12','DECIMAL',2),123456789012);
 for(const value of ['1.001','1e3','-1.00',0.1,'01.00'])assert.throws(()=>moneyMinor(value,'DECIMAL',2));
 for(const path of ['x[0]','constructor.foo','a.__proto__','a..b','$.amount','(()=>1)()'])assert.throws(()=>mapping({...config,fields:{...config.fields,amount:path}}));
 assert.throws(()=>mapping({...config,auth:'NONE'}));
 assert.throws(()=>normalize(mapping(config),{...sample,occurred:'2026-02-30T00:00:00.000Z'}));
 assert.throws(()=>normalize(mapping(config),{...sample,status:'unexpected'}));
 assert.equal(normalize(mapping({...config,fields:{...config.fields,reference:'metadata.ref'}}),sample).reference_present,false);
 const productOnly={...config,fields:{event:'event',order:'order',amount:'amount',currency:'currency',status:'status',occurred:'occurred',product:'product'}};
 assert.equal(normalize(mapping(productOnly),sample).checkout,'');
 assert.equal(JSON.stringify(sampleShape({sk_live_private:'x',Alice_Silva:'x'})).includes('Alice'),false);
 assert.equal(JSON.stringify(sampleShape({email:'private@example.test',secret:'secret',nested:{value:'private'}})).includes('private'),false);
});

test('F29/F31 real PostgreSQL + Chromium: reusable global Custom, accounts, projects, lifecycle, HMAC and consolidated reporting',{timeout:120000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const parent=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='commerce_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA ${schema}`);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 const env={COMMERCE_ENCRYPTION_KEY:'ab'.repeat(32)},oldKey=process.env.COMMERCE_ENCRYPTION_KEY;process.env.COMMERCE_ENCRYPTION_KEY=env.COMMERCE_ENCRYPTION_KEY;
 const handler=commerceWebhook(db,env),server=createServer((req,res)=>{if(!handler(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const password='laboratory password',salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
 const admin=createAdminServer(`scrypt$${salt}$${scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(admin,'listening');
 const adminBase=`http://127.0.0.1:${(admin.address() as AddressInfo).port}`,browser=await chromium.launch();
 type Result={id:string;version:number;currencies:{currency:string;reported_sales:number;reversal_amount_minor:string}[];attributed_sales:number;bindings:unknown[]};
 const api=(body:unknown)=>commerceAdmin(db,body,env) as Promise<Result>; // Domain API tested alongside authenticated browser boundary.
 const send=async(id:string,key:string,value:unknown=sample,overrides:Record<string,string>={})=>{const body=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',Buffer.from(key,'hex')).update(timestamp+'.'+body).digest('hex');return fetch(base+'/commerce-webhook/'+id,{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':timestamp,'x-checkout-signature':signature,...overrides},body});};
 try{
  await db.query(await readFile('infra/003_projects.sql','utf8'));
  await db.query('CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),PRIMARY KEY(id,project_id))');
  await db.query(await readFile('infra/047_observed_metrics.sql','utf8'));
  await db.query(await readFile('infra/048_observed_receipts.sql','utf8'));
  await db.query(await readFile('infra/063_checkout_integrations.sql','utf8'));
  await db.query((await readFile('infra/017_notification_settings.sql','utf8')).replace(/^\uFEFF/,''));
  await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL);CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
  await db.query("INSERT INTO projects VALUES('one','One','https://one.test'),('two','Two','https://two.test')");
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(adminBase+'/admin/ui/');await page.getByLabel('Senha administrativa').fill(password);await page.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.locator('#settings').waitFor({state:'visible'});
  const form=page.locator('form[data-action="model"]');await form.locator('[name=name]').fill('CustomReference');await form.locator('[name=config]').fill(JSON.stringify(config));await form.locator('[name=sample]').fill(JSON.stringify(sample));
  await page.getByRole('button',{name:'Testar interpretação sem salvar'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-result')?.textContent?.includes('1999'));
  await form.locator('[name=reviewed]').check();await form.getByRole('button',{name:'Salvar modelo global Custom revisado',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#commerce-result')?.textContent?.includes('"version": 1'));
  const model=JSON.parse((await page.locator('#commerce-result').textContent())!);
  await assert.rejects(api({action:'model',id:model.id,expected_version:0,name:'wrong',config,sample,reviewed:true}),CommerceConflict);
  const connection=await api({action:'connection',model:model.id,model_version:1,account:'account_a'}),key=await provisionCommerceSender(db,connection.id,env);
  const directory=await mkdtemp(join(tmpdir(),'commerce-provision-'));try{
   const file=join(directory,'sender.key'),url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options','-c search_path='+schema);
   const run=()=>new Promise<{code:number|null;output:string}>(resolve=>{let output='';const child=spawn(process.execPath,['dist/apps/commerce-provision.js',connection.id,file],{env:{...process.env,...env,DATABASE_URL:url.toString()},stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});child.on('exit',code=>resolve({code,output}));});
   const provisioned=await run();assert.equal(provisioned.output.includes(key),false);
   if(process.platform==='win32'){assert.notEqual(provisioned.code,0);assert.ok(provisioned.output.includes('POSIX permissions required'));}
   else {assert.equal(provisioned.code,0);assert.equal((await readFile(file,'utf8')).trim(),key);assert.equal((await stat(file)).mode&0o777,0o600);assert.notEqual((await run()).code,0);assert.equal((await readFile(file,'utf8')).trim(),key);}
  }finally{await rm(directory,{recursive:true,force:true});}
  assert.equal((await send(connection.id,key,sample,{'x-checkout-signature':'00'.repeat(32)})).status,401);
  assert.equal((await send(connection.id,key,sample,{'x-checkout-timestamp':'1000000000'})).status,401);
  assert.equal((await send(connection.id,key,sample,{origin:'https://evil.test'})).status,403);
  assert.equal((await send(connection.id,key,{...sample,ignored:'x'.repeat(3000)})).status,413);
  await assert.rejects(api({action:'connection-state',id:connection.id,expected_version:1,state:'ACTIVE'}),CommerceConflict);
  assert.equal((await (await send(connection.id,key)).json()).mode,'TEST');
  assert.equal((await db.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
  await api({action:'connection-state',id:connection.id,expected_version:1,state:'ACTIVE'});
  const bind={action:'binding',expected_version:0,connection:connection.id,project:'one',product:'p1',offer:'o1',checkout:'c1',url:'https://checkout.test/one',price_minor:1999,currency:'BRL',state:'ACTIVE'};
  const b1=await api(bind);await api({...bind,project:'two',product:'p2',offer:'o2',checkout:'c2'});
  await assert.rejects(api({...bind,project:'two'}),CommerceConflict);
  const second=await api({action:'connection',model:model.id,model_version:1,account:'account_b'}),key2=await provisionCommerceSender(db,second.id,env);
  await send(second.id,key2);await api({action:'connection-state',id:second.id,expected_version:1,state:'ACTIVE'});await api({...bind,connection:second.id});
  const otherModel=await api({action:'model',expected_version:0,name:'OtherCustom',config,sample,reviewed:true});
  const third=await api({action:'connection',model:otherModel.id,model_version:1,account:'account_a'}),key3=await provisionCommerceSender(db,third.id,env);await send(third.id,key3);await api({action:'connection-state',id:third.id,expected_version:1,state:'ACTIVE'});await api({...bind,connection:third.id,currency:'USD'});
  const concurrent=await Promise.all([send(connection.id,key),send(connection.id,key),send(connection.id,key)]);assert.deepEqual(concurrent.map(r=>r.status),[200,200,200]);assert.equal((await Promise.all(concurrent.map(r=>r.json()))).filter(r=>r.duplicate).length,2);
  assert.equal((await send(connection.id,key,{...sample,amount:'20.00'})).status,409);
  assert.equal((await send(connection.id,key,{...sample,event:'e2',currency:'USD'})).status,409);
  await send(connection.id,key,{...sample,event:'two1',order:'order2',product:'p2',offer:'o2',checkout:'c2'});
  await send(second.id,key2);await send(third.id,key3,{...sample,currency:'USD'});
  await api({...bind,id:b1.id,expected_version:1,state:'INACTIVE'});
  await api({action:'connection-state',id:connection.id,expected_version:2,state:'INACTIVE'});
  assert.equal((await send(connection.id,key,{...sample,event:'refund',status:'refunded'})).status,200);
  assert.equal((await send(connection.id,key,{...sample,event:'paid_late'})).status,200);
  assert.equal((await send(connection.id,key,{...sample,event:'new_event',order:'new_order'})).status,409);
  await api({action:'connection-state',id:connection.id,expected_version:3,state:'ACTIVE'});
  await api({...bind,id:b1.id,expected_version:2,state:'ACTIVE',url:'https://checkout.test/new'});
  const revisionRace=await Promise.allSettled([api({...bind,id:b1.id,expected_version:3,price_minor:2099}),api({...bind,id:b1.id,expected_version:3,price_minor:2199})]);assert.equal(revisionRace.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await send(connection.id,key,{...sample,event:'cb',status:'chargeback'})).status,200);
  assert.equal((await send(connection.id,key,{...sample,event:'cancel',status:'cancelled'})).status,200);
  assert.equal((await db.query('SELECT status FROM commerce_orders WHERE connection_id=$1 AND order_id=$2',[connection.id,sample.order])).rows[0].status,'CHARGEBACK');
  // Unknown commercial identities stay unassigned even when bindings are later created.
  await send(second.id,key2,{...sample,event:'unknown',order:'unknown_order',product:'unknown'});
  const observedPage=randomUUID();await db.query('INSERT INTO protected_pages VALUES($1,$2)',[observedPage,'one']);
  await db.query("INSERT INTO observed_action_facts(project_id,page_id,event_id,session_id,action,traffic_class,evidence) VALUES('one',$1,$2,$3,'CTA_CLICK_OBSERVED','ORGANIC','BROWSER_UNVERIFIED')",[observedPage,randomUUID(),'ab'.repeat(16)]);
  await db.query("INSERT INTO estimate_assumptions(project_id,version,ticket_minor,conversion_basis_points,currency) VALUES('one',1,1999,500,'BRL')");
  await db.query("INSERT INTO observed_decision_receipts(id,project_id,page_id,session_id,origin,action,policy_version,traffic_class,points) VALUES($1,'one',$2,$3,'https://copy.test','REPLACE_CONVERSION',1,'ORGANIC','[]')",[randomUUID(),observedPage,'ab'.repeat(16)]);
  const report={action:'report',from:'2026-01-01T00:00:00.000Z',until:'2027-01-01T00:00:00.000Z'};
  const all=await api(report);assert.equal(all.currencies.length,2);assert.equal(all.currencies.find((r:{currency:string})=>r.currency==='BRL')!.reported_sales,4);assert.equal(all.currencies.find((r:{currency:string})=>r.currency==='BRL')!.reversal_amount_minor,'1999');assert.equal(all.attributed_sales,0);
  const one=await api({...report,project:'one'}),two=await api({...report,project:'two'});assert.equal(one.currencies.find((r:{currency:string})=>r.currency==='BRL')!.reported_sales,2);assert.equal(two.currencies[0].reported_sales,1);
  const latest=await api({action:'model',id:model.id,expected_version:1,name:'CustomReferenceV2',config:{...config,money:{unit:'MINOR',exponent:2}},sample:{...sample,amount:1999},reviewed:true});assert.equal(latest.version,2);
  assert.equal((await db.query('SELECT model_version FROM commerce_connections WHERE id=$1',[connection.id])).rows[0].model_version,1);
  const snapshot=await api({action:'list'});assert.equal(JSON.stringify(snapshot).includes(key),false);assert.equal(JSON.stringify(snapshot).includes('secret_encrypted'),false);assert.equal(snapshot.bindings.length,4);
  const consolidated=await commerceAdmin(db,report,env) as {estimated_revenue:{amount_minor_numerator:string}[];prepared_decisions:unknown[]};assert.equal(consolidated.estimated_revenue[0].amount_minor_numerator,'999500');assert.equal(consolidated.prepared_decisions.length,1);
  assert.equal((await commerceAdmin(db,{...report,traffic:'ORGANIC'},env) as {currencies:unknown}).currencies,null);
  // Dates of PENDING, PAID and reversals are independent; reversed delivery order cannot move revenue.
  const temporal={...sample,order:'temporal',event:'tp',status:'pending',occurred:'2026-10-01T00:00:00.000Z'};
  await send(connection.id,key,temporal);await send(connection.id,key,{...temporal,event:'tr',status:'refunded',occurred:'2026-10-03T00:00:00.000Z'});await send(connection.id,key,{...temporal,event:'ts',status:'paid',occurred:'2026-10-02T00:00:00.000Z'});
  const day=(date:string)=>api({...report,from:'2026-10-'+date+'T00:00:00.000Z',until:'2026-10-'+String(Number(date)+1).padStart(2,'0')+'T00:00:00.000Z'});
  assert.equal((await day('01')).currencies[0].reported_sales,0);assert.equal((await day('02')).currencies[0].reported_sales,1);assert.equal((await day('03')).currencies[0].reversal_amount_minor,'1999');
  // TEST mode still admits adjustments to already authenticated orders.
  await api({action:'connection-state',id:second.id,expected_version:2,state:'TEST'});assert.equal((await send(second.id,key2,{...sample,event:'test_refund',status:'refunded'})).status,200);assert.equal((await db.query('SELECT status FROM commerce_orders WHERE connection_id=$1 AND order_id=$2',[second.id,sample.order])).rows[0].status,'REFUNDED');
  await api({action:'connection-state',id:second.id,expected_version:3,state:'ACTIVE'});
  await send(connection.id,key,{...temporal,order:'cancel_only',event:'cp',status:'pending',occurred:'2026-10-04T00:00:00.000Z'});await send(connection.id,key,{...temporal,order:'cancel_only',event:'cc',status:'cancelled',occurred:'2026-10-04T01:00:00.000Z'});assert.equal((await day('04')).currencies[0].reversal_amount_minor,'0');
  await page.getByRole('button',{name:'Atualizar catálogo, conexões e amostras sanitizadas'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-list')?.textContent?.includes('CustomReferenceV2'));
  const csrf=await page.evaluate(async()=>await(await fetch('/admin/ui/bootstrap')).json());const cookie=(await page.context().cookies()).find(c=>c.name==='admin_session')!;
  assert.equal((await fetch(adminBase+'/admin/ui/commerce',{method:'POST',headers:{cookie:`admin_session=${cookie.value}`,origin:adminBase,'sec-fetch-site':'same-origin','content-type':'application/json','x-csrf-token':'bad'},body:'{"action":"list"}'})).status,403);assert.ok(csrf.csrf);
  await api({action:'rotate',id:second.id,expected_version:4});assert.equal((await send(second.id,key2)).status,401);
  const rotated=await provisionCommerceSender(db,second.id,env);assert.equal((await send(second.id,rotated)).status,200);
  assert.deepEqual(errors,[]);
 }finally{if(oldKey===undefined)delete process.env.COMMERCE_ENCRYPTION_KEY;else process.env.COMMERCE_ENCRYPTION_KEY=oldKey;await browser.close();server.closeAllConnections();admin.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>admin.close(()=>r()))]);await db.end();await parent.query(`DROP SCHEMA ${schema} CASCADE`);await parent.end();}
});
