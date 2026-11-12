import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,scryptSync} from 'node:crypto';
import {readFile,mkdtemp,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {TOTP,Secret} from 'otpauth';
import {commerceAdmin,commerceWebhook,provisionCommerceSender,CommerceConflict,commerceSigningInput,type CommerceFormat} from '../apps/commerce.js';
import {mapping,moneyMinor,normalize,sampleShape,sampleFields} from '../apps/commerce-mapping.js';
import {createAdminServer} from '../apps/admin-auth.js';
import {compilePreviousCode} from './previous-code.js';

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

test('migration 064 retains pre-existing account, receipt, money and legacy sample without rewriting history',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);const parent=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='commerce_upgrade_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA ${schema}`);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{
  await db.query(await readFile('infra/003_projects.sql','utf8'));await db.query('CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),PRIMARY KEY(id,project_id))');await db.query(await readFile('infra/047_observed_metrics.sql','utf8'));await db.query(await readFile('infra/063_checkout_integrations.sql','utf8'));
  const model=randomUUID(),connection=randomUUID();await db.query("INSERT INTO commerce_models(id,version,name,config,approved) VALUES($1,2,'LegacyModel',$2,true)",[model,config]);
  await db.query("INSERT INTO commerce_connections(id,model_id,model_version,account,secret_encrypted,state) VALUES($1,$2,2,'legacy_account','synthetic-opaque-ciphertext','ACTIVE')",[connection,model]);
  await db.query("INSERT INTO commerce_orders(connection_id,order_id,amount_minor,currency,product,offer,checkout,paid_reported,status,occurred_at,paid_at,rank) VALUES($1,'legacy_order',1999,'BRL','p1','o1','c1',true,'PAID','2026-11-12','2026-11-12',1)",[connection]);
  await db.query("INSERT INTO commerce_orders(connection_id,order_id,amount_minor,currency,product,offer,checkout,paid_reported,status,occurred_at,paid_at,rank) VALUES($1,'legacy_bad_jpy',1999,'JPY','p1','o1','c1',true,'PAID','2026-11-12','2026-11-12',1)",[connection]);
  await db.query("INSERT INTO commerce_events(connection_id,event_id,order_id,digest) VALUES($1,'legacy_event','legacy_order',$2)",[connection,'ab'.repeat(32)]);await db.query('INSERT INTO commerce_samples(connection_id,shape) VALUES($1,$2)',[connection,{field_1:'[string]'}]);
  await db.query(await readFile('infra/064_commerce_connection_versions.sql','utf8'));
  assert.deepEqual((await db.query("SELECT amount_minor,currency,model_version FROM commerce_orders WHERE order_id='legacy_order'")).rows,[{amount_minor:'1999',currency:'BRL',model_version:2}]);
  assert.deepEqual((await db.query('SELECT digest,canonical_digest,model_version FROM commerce_events')).rows,[{digest:'ab'.repeat(32),canonical_digest:null,model_version:2}]);
  assert.deepEqual((await db.query('SELECT model_version,legacy_model_version,secret_encrypted FROM commerce_connections')).rows,[{model_version:2,legacy_model_version:2,secret_encrypted:'synthetic-opaque-ciphertext'}]);
  assert.equal((await db.query('SELECT model_version FROM commerce_version_samples')).rows[0].model_version,2);assert.equal((await db.query('SELECT state FROM commerce_connection_versions')).rows[0].state,'ACCEPTED');
  const report=await commerceAdmin(db,{action:'report',from:'2026-11-01T00:00:00.000Z',until:'2026-12-01T00:00:00.000Z'}) as {currencies:{currency:string;reported_amount_minor:string|null;monetary_integrity:string}[]};
  assert.equal(report.currencies.find(r=>r.currency==='JPY')!.reported_amount_minor,null);assert.equal(report.currencies.find(r=>r.currency==='JPY')!.monetary_integrity,'UNVERIFIED_HISTORICAL_CONTRACT');assert.equal(report.currencies.find(r=>r.currency==='BRL')!.reported_amount_minor,'1999');
 }finally{await db.end();await parent.query(`DROP SCHEMA ${schema} CASCADE`);await parent.end();}
});

test('currency/exponent contracts reject incompatible BRL USD JPY and three-decimal currencies without rounding',()=>{
 for(const [currency,exponent,amount,expected] of [['BRL',2,'19.99',1999],['USD',2,'0.01',1],['JPY',0,'1999',1999],['KWD',3,'1.234',1234],['BHD',3,'0.001',1]] as const){
  const configured=mapping({...config,money:{unit:'DECIMAL',exponent}});
  assert.equal(normalize(configured,{...sample,currency,amount}).amount,expected);
  assert.equal(normalize(mapping({...config,money:{unit:'MINOR',exponent}}),{...sample,currency,amount:expected}).amount,expected);
  for(const incompatible of [0,1,2,3].filter(n=>n!==exponent))assert.throws(()=>normalize(mapping({...config,money:{unit:'DECIMAL',exponent:incompatible}}),{...sample,currency,amount}));
 }
 assert.throws(()=>normalize(mapping(config),{...sample,currency:'ZZZ'}));
 assert.throws(()=>normalize(mapping({...config,money:{unit:'DECIMAL',exponent:0}}),{...sample,currency:'JPY',amount:'19.99'}));
 assert.throws(()=>normalize(mapping({...config,money:{unit:'DECIMAL',exponent:3}}),{...sample,currency:'KWD',amount:'1.2345'}));
 const fields=sampleFields({data:{payment:{amount:'private',currency:'private'},email:'private',sk_live_123:'x',Alice_Silva:'x'},event:'secret_value'});
 assert.deepEqual(fields.map(f=>f.path),['data','data.payment','data.payment.amount','data.payment.currency','event']);
 assert.equal(JSON.stringify(fields).includes('private'),false);assert.equal(JSON.stringify(fields).includes('secret_value'),false);
});

test('064 executable rollback: exact 2bf9a04 receiver works before format migration and fails closed after it',{timeout:120000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='commerce_rollback_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`}),env={COMMERCE_ENCRYPTION_KEY:'cd'.repeat(32)};let previous='',server:ReturnType<typeof createServer>|undefined;
 try{
  await db.query(await readFile('infra/003_projects.sql','utf8'));await db.query('CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),PRIMARY KEY(id,project_id))');await db.query(await readFile('infra/063_checkout_integrations.sql','utf8'));await db.query(await readFile('infra/064_commerce_connection_versions.sql','utf8'));
  previous=await compilePreviousCode('2bf9a0417cb2f9d35d9fcfc0edc953bdf526d2ca');const old=await import(pathToFileURL(join(previous,'dist/apps/commerce.js')).href) as typeof import('../apps/commerce.js');
  const api=(body:unknown)=>old.commerceAdmin(db,body,env) as Promise<{id:string;version:number}>;
  const model=await api({action:'model',expected_version:0,name:'RollbackCustom',config,sample,reviewed:true}),connection=await api({action:'connection',model:model.id,model_version:1,account:'rollback_account'}),key=await old.provisionCommerceSender(db,connection.id,env);
  const handle=old.commerceWebhook(db,env);server=createServer((req,res)=>{if(!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send=(payload:unknown)=>{const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',Buffer.from(key,'hex')).update(timestamp+'.'+raw).digest('hex');return fetch(base+'/commerce-webhook/'+connection.id,{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':timestamp,'x-checkout-signature':signature},body:raw});};
  assert.equal((await (await send(sample)).json()).mode,'TEST');await api({action:'connection-state',id:connection.id,expected_version:1,state:'ACTIVE'});assert.equal((await send(sample)).status,200);assert.equal((await (await send(sample)).json()).duplicate,true);
  assert.equal((await db.query('SELECT model_version FROM commerce_orders')).rows[0].model_version,1);assert.equal((await db.query('SELECT model_version FROM commerce_version_samples')).rows[0].model_version,1);
  await commerceAdmin(db,{action:'model',id:model.id,expected_version:1,name:'RollbackCustom',config:{...config,money:{unit:'MINOR',exponent:2}},sample:{...sample,amount:1999},reviewed:true},env);
  await commerceAdmin(db,{action:'migration-prepare',id:connection.id,expected_version:2,target_version:2,old_sample:sample,sample:{...sample,amount:1999},reviewed:true},env);
  const raw=Buffer.from(JSON.stringify({...sample,amount:1999})),timestamp=String(Math.floor(Date.now()/1000)),format={version:2,test:true};
  const signature=createHmac('sha256',Buffer.from(key,'hex')).update(commerceSigningInput(timestamp,raw,format)).digest('hex');await import('../apps/commerce.js').then(m=>m.receiveCommerce(db,connection.id,raw,timestamp,signature,env,Date.now(),format));
  await commerceAdmin(db,{action:'migration-commit',id:connection.id,expected_version:3,target_version:2,reviewed:true},env);
  assert.equal((await send({...sample,event:'old_new_order',order:'old_new_order',amount:1999})).status,503);
  assert.equal((await send({...sample,event:'old_refund',status:'refunded',amount:1999})).status,503);
  assert.equal((await db.query('SELECT status FROM commerce_orders')).rows[0].status,'PAID');assert.equal((await db.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,1);
 }finally{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();if(previous)await rm(previous,{recursive:true,force:true});}
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
 const send=async(id:string,key:string,value:unknown=sample,overrides:Record<string,string>={},format:CommerceFormat={},algorithm='sha256')=>{const body=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac(algorithm,Buffer.from(key,'hex')).update(commerceSigningInput(timestamp,Buffer.from(body),format)).digest('hex');return fetch(base+'/commerce-webhook/'+id,{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':timestamp,'x-checkout-signature':signature,...(format.version?{'x-checkout-model-version':String(format.version)}:{}),...(format.test?{'x-checkout-test':'1'}:{}),...overrides},body});};
 try{
  await db.query(await readFile('infra/003_projects.sql','utf8'));
  await db.query('CREATE TABLE protected_pages(id uuid,project_id text REFERENCES projects(id),PRIMARY KEY(id,project_id))');
  await db.query(await readFile('infra/047_observed_metrics.sql','utf8'));
  await db.query(await readFile('infra/048_observed_receipts.sql','utf8'));
  await db.query(await readFile('infra/063_checkout_integrations.sql','utf8'));
  await db.query(await readFile('infra/064_commerce_connection_versions.sql','utf8'));
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
  // Controlled same-account migration: separate preparation, authenticated test and commit.
  const older={...sample,event:'before_migrate',order:'before_migrate'};assert.equal((await send(connection.id,key,older)).status,200);
  const prepare={action:'migration-prepare',id:connection.id,expected_version:4,target_version:2,reviewed:true,old_sample:sample,sample:{...sample,amount:1999}};
  await assert.rejects(api({...prepare,reviewed:false}),TypeError);
  await assert.rejects(api({...prepare,sample:{...sample,amount:2000}}),CommerceConflict);
  const preparing=await Promise.allSettled([api(prepare),api(prepare)]);assert.equal(preparing.filter(r=>r.status==='fulfilled').length,1);
  const committing={action:'migration-commit',id:connection.id,expected_version:5,target_version:2,reviewed:true};
  await assert.rejects(api(committing),CommerceConflict);
  const testPayload={...sample,event:'version_probe',order:'version_probe',amount:1999};
  const beforeTest=(await db.query('SELECT count(*)::int n FROM commerce_events')).rows[0].n;
  assert.equal((await send(connection.id,key,testPayload,{}, {version:2})).status,409);
  assert.equal((await send(connection.id,key,testPayload,{'x-checkout-model-version':'1'},{version:2,test:true})).status,401);
  assert.equal((await send(connection.id,key,testPayload,{'x-checkout-test':'0'},{version:2,test:true})).status,401);
  assert.equal((await (await send(connection.id,key,testPayload,{}, {version:2,test:true})).json()).mode,'TEST');
  assert.equal((await db.query('SELECT count(*)::int n FROM commerce_events')).rows[0].n,beforeTest);
  await db.query("UPDATE commerce_version_samples SET received_at=clock_timestamp()-interval '25 hours' WHERE connection_id=$1 AND model_version=2",[connection.id]);await assert.rejects(api(committing),CommerceConflict);
  assert.equal((await send(connection.id,key,testPayload,{},{version:2,test:true})).status,200);
  // Expiring the legacy mirror must preserve the fresh authenticated pending version.
  await db.query("UPDATE commerce_samples SET received_at=clock_timestamp()-interval '25 hours' WHERE connection_id=$1",[connection.id]);
  assert.deepEqual((await db.query("SELECT model_version,received_at>clock_timestamp()-interval '24 hours' AS valid FROM commerce_version_samples WHERE connection_id=$1 ORDER BY model_version",[connection.id])).rows,[{model_version:1,valid:false},{model_version:2,valid:true}]);
  await db.query("DELETE FROM commerce_samples WHERE received_at<clock_timestamp()-interval '24 hours'");
  assert.equal((await db.query('SELECT 1 FROM commerce_samples WHERE connection_id=$1',[connection.id])).rowCount,0);
  assert.deepEqual((await db.query('SELECT model_version FROM commerce_version_samples WHERE connection_id=$1',[connection.id])).rows,[{model_version:2}]);
  const commits=await Promise.allSettled([api(committing),api(committing)]);assert.equal(commits.filter(r=>r.status==='fulfilled').length,1);
  const replay=await send(connection.id,key,{...sample,amount:1999},{},{version:2});assert.equal(replay.status,200);assert.equal((await replay.json()).duplicate,true);
  await db.query('UPDATE commerce_events SET canonical_digest=NULL WHERE connection_id=$1 AND event_id=$2',[connection.id,sample.event]);
  assert.equal((await send(connection.id,key,{...sample,amount:1999},{},{version:2})).status,409);assert.equal((await send(connection.id,key,sample)).status,200);
  const mixed=await Promise.all([send(connection.id,key,{...sample,event:'mixed_order',order:'mixed_order'}),send(connection.id,key,{...sample,event:'mixed_order',order:'mixed_order',amount:1999},{},{version:2})]);assert.deepEqual(mixed.map(r=>r.status),[200,200]);
  assert.equal((await db.query("SELECT count(*)::int n FROM commerce_orders WHERE connection_id=$1 AND order_id='mixed_order'",[connection.id])).rows[0].n,1);
  assert.equal((await send(connection.id,key,{...older,event:'late_old_refund',status:'refunded'})).status,200);
  assert.equal((await send(connection.id,key,{...older,event:'late_new_paid',amount:1999},{},{version:2})).status,200);
  assert.equal((await db.query("SELECT status,model_version FROM commerce_orders WHERE connection_id=$1 AND order_id='before_migrate'",[connection.id])).rows[0].status,'REFUNDED');
  assert.equal((await db.query("SELECT model_version FROM commerce_orders WHERE connection_id=$1 AND order_id='before_migrate'",[connection.id])).rows[0].model_version,1);
  const orderCount=(await db.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n;
  assert.equal((await send(connection.id,key,{...sample,event:'bad_jpy',order:'bad_jpy',currency:'JPY',amount:1999},{},{version:2})).status,400);
  assert.equal((await db.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,orderCount);
  await assert.rejects(api({action:'connection',model:model.id,model_version:2,account:'account_a'}),CommerceConflict);
  // Additional protocol is a fixed SHA-512 HMAC contract, not arbitrary authentication.
  await api({action:'model',id:model.id,expected_version:2,name:'CustomSHA512',config:{...config,auth:'HMAC_SHA512_TIMESTAMP',money:{unit:'MINOR',exponent:2}},sample:{...sample,amount:1999},reviewed:true});
  const prepare3={...prepare,expected_version:6,target_version:3,old_sample:{...sample,amount:1999}};await api(prepare3);
  assert.equal((await send(connection.id,key,testPayload,{},{version:3,test:true})).status,401);
  assert.equal((await send(connection.id,key,testPayload,{},{version:3,test:true},'sha512')).status,200);
  await api({...committing,expected_version:7,target_version:3});
  assert.equal((await send(connection.id,key,{...testPayload,event:'sha512_paid',order:'sha512_paid'},{},{version:3},'sha512')).status,200);
  assert.equal((await send(connection.id,key,{...testPayload,event:'wrong512',order:'wrong512'},{},{version:3})).status,401);
  const connectionRow=(await db.query('SELECT model_version,legacy_model_version FROM commerce_connections WHERE id=$1',[connection.id])).rows[0];assert.deepEqual(connectionRow,{model_version:3,legacy_model_version:1});
  const history=await commerceAdmin(db,{action:'history',id:connection.id},env) as {operation:string}[];assert.ok(history.some(h=>h.operation==='MIGRATION_ACCEPTED_V2'));assert.ok(history.some(h=>h.operation==='MIGRATION_ACCEPTED_V3'));
  // PAID followed by CANCELLED is unresolved, never evidence of refund or settlement.
  await send(connection.id,key,{...sample,event:'paid_cancel_paid',order:'paid_cancel',occurred:'2026-10-05T00:00:00.000Z'});
  await send(connection.id,key,{...sample,event:'paid_cancel_cancel',order:'paid_cancel',status:'cancelled',occurred:'2026-10-06T00:00:00.000Z'});
  const uncertain=await commerceAdmin(db,{...report,from:'2026-10-05T00:00:00.000Z',until:'2026-10-07T00:00:00.000Z'},env) as {financial_basis:string;settled_revenue:null;currencies:{net_amount_minor:null;reported_balance_minor:string;cancelled_payment_uncertain_minor:string;reversal_amount_minor:string}[]};
  assert.equal(uncertain.currencies[0].net_amount_minor,null);assert.equal(uncertain.currencies[0].reported_balance_minor,'1999');assert.equal(uncertain.currencies[0].reversal_amount_minor,'0');assert.equal(uncertain.currencies[0].cancelled_payment_uncertain_minor,'1999');assert.equal(uncertain.settled_revenue,null);
  await send(connection.id,key,{...sample,event:'paid_cancel_refund',order:'paid_cancel',status:'refunded',occurred:'2026-10-07T00:00:00.000Z'});
  const resolved=await commerceAdmin(db,{...report,from:'2026-10-05T00:00:00.000Z',until:'2026-10-08T00:00:00.000Z'},env) as {settled_revenue:null;currencies:{net_amount_minor:string;reported_balance_minor:string;reversal_amount_minor:string}[]};assert.equal(resolved.currencies[0].net_amount_minor,'0');assert.equal(resolved.currencies[0].reversal_amount_minor,'1999');assert.equal(resolved.settled_revenue,null);
  // Browser selectors show reusable names, configured paths and accounts rather than UUID entry.
  await page.getByRole('button',{name:'Atualizar catálogo, conexões e amostras sanitizadas'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-list')?.textContent?.includes('CustomSHA512'));
  const connectionUi=page.locator('form[data-action="connection"]');await connectionUi.locator('[name=model]').selectOption(model.id);await connectionUi.locator('[name=model_version]').selectOption('3');assert.ok((await connectionUi.locator('[name=model] option:checked').textContent())?.includes('CustomSHA512'));
  await page.getByRole('button',{name:'Identificar caminhos sanitizados da amostra'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-result')?.textContent?.includes('"path"'));
  assert.ok(await page.locator('#commerce-field-paths option[value="amount"]').count());
  assert.equal(await page.locator('form[data-action="binding"] select[name=project] option[value="one"]').count(),1);
  assert.equal(await page.locator('form[data-action="report"] select[name=checkout] option[value="c1"]').count(),1);
  // Full UI migration preparation and cancellation without typing connection/model UUIDs.
  const config512={...config,auth:'HMAC_SHA512_TIMESTAMP',money:{unit:'MINOR',exponent:2}};
  await api({action:'model',id:model.id,expected_version:3,name:'CustomSHA512Stage',config:config512,sample:{...sample,amount:1999},reviewed:true});
  await page.getByRole('button',{name:'Atualizar catálogo, conexões e amostras sanitizadas'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-list')?.textContent?.includes('CustomSHA512Stage'));
  const migrateUi=page.locator('form[data-action="migration-prepare"]');await migrateUi.locator('[name=id]').selectOption(connection.id);await migrateUi.locator('[name=target_version]').selectOption('4');await migrateUi.locator('[name=old_sample]').fill(JSON.stringify({...sample,amount:1999}));await migrateUi.locator('[name=sample]').fill(JSON.stringify({...sample,amount:1999}));await migrateUi.locator('[name=reviewed]').check();await migrateUi.getByRole('button',{name:'Preparar migração revisada',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#commerce-result')?.textContent?.includes('"state": "PENDING"'));
  await page.getByRole('button',{name:'Atualizar catálogo, conexões e amostras sanitizadas'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-list')?.textContent?.includes('"version": 9'));
  const cancelUi=page.locator('form[data-action="migration-cancel"]');await cancelUi.locator('[name=id]').selectOption(connection.id);await cancelUi.locator('[name=target_version]').selectOption('4');await cancelUi.locator('[name=reviewed]').check();await cancelUi.getByRole('button',{name:'Cancelar migração pendente',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#commerce-result')?.textContent?.includes('"version": 10'));
  assert.equal((await db.query('SELECT 1 FROM commerce_connection_versions WHERE connection_id=$1 AND model_version=4',[connection.id])).rowCount,0);
  await api({action:'model',id:model.id,expected_version:4,name:'CustomAliases',config:{...config512,statuses:{...config.statuses,approved:'PAID',['__proto__']:'PENDING'}},sample:{...sample,amount:1999},reviewed:true});
  await page.getByRole('button',{name:'Atualizar catálogo, conexões e amostras sanitizadas'}).click();await page.waitForFunction(()=>document.querySelector('#commerce-list')?.textContent?.includes('CustomAliases'));await form.locator('[name=id]').selectOption(model.id);
  await page.getByLabel('Caminho JSON: reference',{exact:true}).fill('metadata.ref');await page.getByLabel('Caminho JSON: reference',{exact:true}).dispatchEvent('change');
  const edited=JSON.parse(await form.locator('[name=config]').inputValue());assert.equal(edited.statuses.approved,'PAID');assert.equal(edited.statuses.paid,'PAID');assert.equal(Object.hasOwn(edited.statuses,'__proto__'),true);assert.equal(edited.statuses['__proto__'],'PENDING');
  await form.locator('[name=reviewed]').check();const pendingControl=page.getByLabel('Valores de status (vírgula) para PENDING',{exact:true});await pendingControl.fill('paid');await pendingControl.dispatchEvent('change');
  assert.equal(await form.locator('[name=reviewed]').isChecked(),false);assert.equal(await form.locator('fieldset input').evaluateAll(nodes=>nodes.some(n=>(n as HTMLInputElement).validity.customError)),true);
  let staleWrites=0,staleTests=0;const observeWrite=(req:import('playwright').Request)=>{if(req.url().endsWith('/admin/ui/commerce')){if(req.postDataJSON()?.action==='model')staleWrites++;if(req.postDataJSON()?.action==='test')staleTests++;}};page.on('request',observeWrite);await form.locator('[name=reviewed]').check();await form.getByRole('button',{name:'Salvar modelo global Custom revisado',exact:true}).click();await page.getByRole('button',{name:'Testar interpretação sem salvar'}).click();assert.equal(staleWrites,0);assert.equal(staleTests,0);page.off('request',observeWrite);
  await pendingControl.fill('pending,__proto__');await pendingControl.dispatchEvent('change');assert.equal(await form.locator('fieldset input').evaluateAll(nodes=>nodes.some(n=>(n as HTMLInputElement).validity.customError)),false);
  // Authenticated money reaches PostgreSQL unchanged for each supported precision.
  for(const [currency,exponent,amount,minor] of [['BRL',2,'12.34',1234],['USD',2,'12.34',1234],['JPY',0,'1234',1234],['KWD',3,'1.234',1234],['BHD',3,'1.234',1234]] as const){
   const payload={...sample,event:'money_'+currency,order:'money_'+currency,currency,amount};const m=await api({action:'model',expected_version:0,name:'Money_'+currency,config:{...config,money:{unit:'DECIMAL',exponent}},sample:payload,reviewed:true});
   const c=await api({action:'connection',model:m.id,model_version:1,account:'money_account'}),k=await provisionCommerceSender(db,c.id,env);assert.equal((await send(c.id,k,payload)).status,200);await api({action:'connection-state',id:c.id,expected_version:1,state:'ACTIVE'});await api({...bind,connection:c.id,currency,price_minor:minor});assert.equal((await send(c.id,k,payload)).status,200);
   const saved=(await db.query('SELECT amount_minor,currency FROM commerce_orders WHERE connection_id=$1',[c.id])).rows[0];assert.deepEqual(saved,{amount_minor:String(minor),currency});
  }
  // Rotation still invalidates every accepted version, including a legacy sample.
  assert.equal((await send(connection.id,key,sample,{},{version:1,test:true})).status,200);
  assert.equal((await send(connection.id,key,testPayload,{},{version:2,test:true})).status,200);
  assert.equal((await db.query('SELECT count(*)::int n FROM commerce_version_samples WHERE connection_id=$1',[connection.id])).rows[0].n,3);
  await api({action:'rotate',id:connection.id,expected_version:10});
  assert.equal((await db.query('SELECT 1 FROM commerce_version_samples WHERE connection_id=$1',[connection.id])).rowCount,0);
  assert.equal((await send(connection.id,key,sample)).status,401);
  assert.deepEqual(errors,[]);
 }finally{if(oldKey===undefined)delete process.env.COMMERCE_ENCRYPTION_KEY;else process.env.COMMERCE_ENCRYPTION_KEY=oldKey;await browser.close();server.closeAllConnections();admin.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>admin.close(()=>r()))]);await db.end();await parent.query(`DROP SCHEMA ${schema} CASCADE`);await parent.end();}
});
