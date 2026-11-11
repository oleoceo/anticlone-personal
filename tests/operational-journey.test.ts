import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {readFile,readdir,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {SMTPServer} from 'smtp-server';
import {TOTP,Secret} from 'otpauth';
import {createAdminServer} from '../apps/admin-auth.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {distributionGateway} from '../apps/distribution-gateway.js';
import {selected,type Allocation} from '../apps/allocation.js';

const classes=['PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN'] as const;
const allocation=(n:number):Allocation=>({PAID_ATTRIBUTED:n,ORGANIC:n,REFERRAL:n,DIRECT_UNKNOWN:n});
async function until(check:()=>Promise<boolean>){for(let n=0;n<150;n++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('journey receipt timeout');}

for(const width of [1440,390])test(`GS01-04/06/13/16/17: continuous operational owner journey, viewport ${width}`,{timeout:180000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='journey_'+randomUUID().replaceAll('-','');
 await root.query(`CREATE SCHEMA ${schema}`);const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 const directory=await mkdtemp(join(tmpdir(),'anticlone-journey-')),saved={...process.env};
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,admin:ReturnType<typeof createAdminServer>|undefined,gateway:ReturnType<typeof createServer>|undefined;
 let rejectMail=true;const messages:string[]=[];
 const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,done){let body='';stream.on('data',c=>body+=String(c));stream.on('end',()=>{if(rejectMail)done(Error('synthetic transport failure'));else{messages.push(body);done();}});}});
 smtp.listen(0,'127.0.0.1');await once(smtp.server,'listening');const sa=smtp.server.address();assert.ok(sa&&typeof sa!=='string');
 try{
  for(const f of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+f,'utf8')).replace(/^\uFEFF/,''));
  await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL); CREATE TABLE admin_totp_codes(factor_id text,digest text,valid_until bigint,PRIMARY KEY(factor_id,digest))');
  process.env.GATEWAY_MODE='OPERATIONAL';for(const k of Object.keys(process.env))if(/^(SCOPED_LAB_|LAB_CONTROLLED_)/.test(k))delete process.env[k];
  const scripts=Object.fromEntries(await Promise.all([['runtime.js','bootstrap.js'],['core.js','core.js'],['fallback.js','fallback.js']].map(async([name,file])=>[name,await readFile('runtime/'+file)])));
  const handle=scopedGateway(db,scripts,async()=>true),distributed=distributionGateway(db,scripts,(req,res)=>{if(!handle(req,res))res.writeHead(404).end();});
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key'),'-out',join(directory,'cert'),'-days','1','-subj','/CN=gateway.test'],{stdio:'ignore'});
  gateway=createServer({key:await readFile(join(directory,'key')),cert:await readFile(join(directory,'cert'))},(req,res)=>{if(!distributed(req,res)&&!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(gateway,'listening');const ga=gateway.address();assert.ok(ga&&typeof ga!=='string');
  const base='https://gateway.test:'+ga.port;process.env.RUNTIME_PUBLIC_ORIGIN=base;
  const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',salt='0123456789abcdef0123456789abcdef';
  admin=createAdminServer(`scrypt$${salt}$${scryptSync('journey-password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(admin,'listening');const aa=admin.address();assert.ok(aa&&typeof aa!=='string');
  browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP gateway.test 127.0.0.1']});
  const context=await browser.newContext({viewport:{width,height:900},ignoreHTTPSErrors:true});
  const panel=await context.newPage();await panel.goto('http://127.0.0.1:'+aa.port+'/admin/ui/');
  await panel.locator('#login [name=password]').fill('journey-password');await panel.locator('#login [name=code]').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await panel.locator('#login button').click();await panel.locator('#project-create').waitFor();
  const submit=async(selector:string,button:string,endpoint:string,body=false)=>{assert.equal(await panel.locator(selector).evaluate(el=>!(el instanceof HTMLFormElement)||el.checkValidity()),true,'valid form: '+selector);const response=panel.waitForResponse(r=>r.url().endsWith('/admin/ui/'+endpoint)&&r.request().method()==='POST');await panel.locator(selector).locator(button).click();const r=await response;assert.equal(r.status(),200,selector+' '+r.url());const result=body?await r.json():null;if(endpoint==='protection')await panel.waitForFunction(()=>!document.querySelector<HTMLElement>('#protection-page')?.closest('section')?.inert);return result;};
  const original='https://owner.test',copy='https://copy.test';
  await panel.locator('#project-create [name=name]').fill('Continuous '+width);await panel.locator('#project-create [name=origin]').fill(original);
  const project=(await submit('#project-create','button','project-create',true)).id as string;assert.ok(project);
  await panel.locator('#pages-form [name=project]').fill(project);await panel.locator('#pages-form [name=name]').fill('Owned LP');await panel.locator('#pages-form [name=url]').fill(original+'/lp');
  await submit('#pages-form','button[value=create]','pages');
  const lp=(await db.query('SELECT id,installation_id FROM protected_pages WHERE project_id=$1',[project])).rows[0];assert.ok(lp);
  await panel.locator('#pages-form [name=page]').fill(lp.id);
  const distributionForm=panel.locator('#distribution-form');await distributionForm.locator('[name=project]').fill(project);await distributionForm.locator('[name=page]').fill(lp.id);
  const publication=await submit('#distribution-form','button[value=publish]','distribution',true);
  const snippet=publication.snippets.html as string,css=publication.snippets.css as string;assert.match(snippet,/\/r\/v2\//);
  const dist=publication.distribution;const decisionUrl=dist.bases.TELEMETRY+dist.paths['entry-decision'];
  // Only synthetic owner/copy documents are supplied; assets, observations,
  // policies, decisions, redirects and SMTP use real servers and PostgreSQL.
  await context.grantPermissions(['local-network-access'],{origin:copy});
  await context.route(/https:\/\/(owner|copy)\.test\//,r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/lp'?`<style>${css}</style><div class="anticlone-canary" data-anticlone-surface="landing"><a data-anticlone-point="checkout01" href="/native-checkout">Comprar</a><button id="popup" onclick="document.querySelector('#chat').hidden=false">WhatsApp</button><div id="chat" hidden><a data-anticlone-point="chat0001" href="/native-chat">Comprar</a></div></div>${snippet}`:'<h1>Controlled destination</h1>'}));
  const visit=await context.newPage();await visit.goto(original+'/lp');await visit.waitForTimeout(150);assert.equal(visit.url(),original+'/lp');
  assert.equal((await db.query('SELECT count(*)::int n FROM incidents WHERE project_id=$1',[project])).rows[0].n,0);
  await visit.goto(copy+'/lp');
  await until(async()=>(await db.query("SELECT count(*)::int n FROM observation_source_days WHERE project_id=$1 AND host='copy.test'",[project])).rows[0].n>=2);
  await until(async()=>(await db.query("SELECT count(*)::int n FROM canary_observations WHERE project_id=$1 AND host='copy.test'",[project])).rows[0].n===2);
  await visit.reload();await visit.waitForTimeout(150);
  assert.equal((await db.query("SELECT count(*)::int n FROM incidents WHERE project_id=$1 AND host='copy.test'",[project])).rows[0].n,1);
  const worker=async()=>{const child=spawn(process.execPath,['--input-type=module','-e',`import {Pool} from 'pg';import {deliverOne} from './dist/apps/alerts.js';const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:process.env.JOURNEY_SCHEMA});try{await deliverOne(db,process.env.JOURNEY_PROJECT,Number(process.env.JOURNEY_SMTP));}finally{await db.end();}`],{env:{...process.env,JOURNEY_SCHEMA:`-c search_path=${schema}`,JOURNEY_PROJECT:project,JOURNEY_SMTP:String(sa.port)},stdio:['ignore','ignore','inherit']});const [code]=await once(child,'exit');assert.equal(code,0);};
  await worker();assert.equal(messages.length,0);assert.equal((await db.query('SELECT outcome FROM clone_delivery_attempts')).rows[0].outcome,'FAILED');
  await db.query("UPDATE alert_outbox SET next_attempt=now()-interval '1 second'");rejectMail=false;
  await worker();await worker();assert.equal(messages.length,1);assert.match(messages[0],/copy.test/);
  await panel.locator('#incident-query [name=project]').selectOption(project);await submit('#incident-query','button','incidents');await panel.getByText(/Alerta inicial: ACCEPTED_BY_TRANSPORT/).waitFor();
  assert.match(await panel.locator('#incident-list h3').innerText(),/copy.test.*primeira:.*última:/);
  await panel.locator('#protection-project').selectOption(project);await submit('#protection-scope','button','protection');
  for(const [offer,url] of [['checkout',original+'/checkout-approved'],['chat',original+'/whatsapp-approved']]){await panel.locator('#protection-destination [name=offer]').fill(offer);await panel.locator('#protection-destination [name=url]').fill(url);await submit('#protection-destination','button','protection');}
  await panel.locator('#cta-query [name=project]').fill(project);await panel.locator('#cta-query [name=surface]').fill('landing');
  await panel.locator('#protection-cta [name=surface]').fill('landing');await panel.locator('#protection-cta [name=pathname]').fill('/lp');await panel.locator('#protection-cta [name=stealthMode]').selectOption('OFF');await submit('#protection-cta','button','protection');
  await panel.locator('#cta-manual-import [name=project]').fill(project);await panel.locator('#cta-manual-import [name=surface]').fill('landing');await panel.locator('#cta-manual-import [name=pathname]').fill('/lp');await panel.locator('#cta-manual-import [name=candidates]').fill(JSON.stringify([{marker:'checkout01',kind:'a',parent:'div',ordinal:1,url:copy+'/native-checkout'},{marker:'chat0001',kind:'a',parent:'div',ordinal:2,url:copy+'/native-chat'}]));await submit('#cta-manual-import','button','cta-import');
  for(const [marker,offer] of [['checkout01','checkout'],['chat0001','chat']]){await submit('#cta-query','button','cta-inventory');await panel.locator('#cta-list label').filter({hasText:'marcador: '+marker}).locator('input').check();const destination=(await db.query('SELECT id FROM cta_destinations WHERE project_id=$1 AND offer=$2',[project,offer])).rows[0].id;await panel.locator('#cta-select [name=destination]').selectOption(destination);await submit('#cta-select','#cta-map','protection');}
  await panel.locator('#protection-page [name=enabled]').check();await panel.locator('#protection-page [name=destination]').selectOption(original+'/checkout-approved');await panel.locator('#protection-page [name=stealthMode]').selectOption('OFF');
  await panel.locator('#protection-cta [name=enabled]').check();await panel.locator('#protection-cta [name=surface]').fill('landing');await panel.locator('#protection-cta [name=pathname]').fill('/lp');await panel.locator('#protection-cta [name=stealthMode]').selectOption('OFF');
  let revision=0;
  const configure=async(pagePercent:number,ctaPercent:number)=>{
   for(const [selector,value] of [['#protection-page',pagePercent],['#protection-cta',ctaPercent]] as const){await panel.locator(selector+' [name=enabled]').check();await panel.locator(selector+' [name=stealthMode]').selectOption('OFF');if(selector==='#protection-cta'){await panel.locator(selector+' [name=surface]').fill('landing');await panel.locator(selector+' [name=pathname]').fill('/lp');}else await panel.locator(selector+' [name=destination]').selectOption(original+'/checkout-approved');for(const c of classes)await panel.locator(selector+` [name=${c}]`).fill(String(value));await submit(selector,'button','protection');}
   await submit('#pages-form','button[value=inspect]','pages');await panel.locator('#page-approval [name=entry]').selectOption({index:1});for(const box of await panel.locator('#page-approval-ctas input').all())await box.check();await submit('#page-approval','button','pages');
   const f=panel.locator('#operational-form');await f.locator('[name=project]').fill(project);await f.locator('[name=page]').fill(lp.id);await f.locator('[name=revision]').fill(String(revision));await f.locator('[name=copyOrigin]').fill(copy);await f.locator('[name=copyPathname]').fill('/lp');await f.locator('[name=acknowledge]').check();await submit('#operational-form','button[value=authorize]','operational');revision++;
  };
  // Real browser outcomes in both buckets at 50%, independently for each action/class.
  for(const action of ['REPLACE_CONVERSION','PAGE_REDIRECT'] as const)for(const percent of [0,50,100]){
   await configure(action==='PAGE_REDIRECT'?percent:0,action==='REPLACE_CONVERSION'?percent:0);
   const table=action==='PAGE_REDIRECT'?'protection_policy_versions':'cta_policy_versions';const version=(await db.query(`SELECT max(version)::int n FROM ${table} WHERE project_id=$1`,[project])).rows[0].n;
   for(const kind of classes){
    const ids=Array.from({length:200},(_,n)=>n.toString(16).padStart(32,'0'));const accepted=ids.find(id=>selected(id,action,version,allocation(percent),kind));const rejected=ids.find(id=>!selected(id,action,version,allocation(percent),kind));
    for(const id of percent===50?[accepted!,rejected!]:[percent===100?accepted!:rejected!]){
     const active=selected(id,action,version,allocation(percent),kind),signals=kind==='PAID_ATTRIBUTED'?{medium:'cpc'}:kind==='ORGANIC'?{referrerHost:'google.com'}:kind==='REFERRAL'?{referrerHost:'referrer.fixture.test'}:{};
     const p=await context.newPage();await p.addInitScript(({id,signals})=>{sessionStorage.setItem('anticlone.lab.session',id);sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify(signals));},{id,signals});
     const response=p.waitForResponse(r=>r.url()===decisionUrl);await p.goto(copy+'/lp');const received=await response;assert.equal(received.status(),200);
     if(!(action==='PAGE_REDIRECT'&&active))assert.equal((await received.json()).action,active?action:'OBSERVE_ONLY');
     if(action==='PAGE_REDIRECT'&&active)await p.waitForURL(original+'/checkout-approved');
     else{
      await p.waitForTimeout(80);await p.locator('#popup').click();await p.locator('[data-anticlone-point=checkout01]').evaluate(el=>{el.textContent='Descrição alterada';});
      let decisionRequests=0;p.on('request',r=>{if(r.url()===decisionUrl||r.url()===dist.bases.TELEMETRY+dist.paths['cta-refresh'])decisionRequests++;});
      await p.locator('[data-anticlone-point=chat0001]').click();await p.waitForURL((active?original+'/whatsapp-approved':copy+'/native-chat'));assert.equal(decisionRequests,0);
     }
     await p.close();
    }
   }
  }
  await configure(0,100);
  await panel.locator('#operational-form [name=revision]').fill(String(revision));await submit('#operational-form','button[value=suspend]','operational');revision++;
  const suspended=visit.waitForResponse(r=>r.url()===decisionUrl);await visit.goto(copy+'/lp');assert.equal((await (await suspended).json()).action,'OBSERVE_ONLY');await visit.locator('[data-anticlone-point=checkout01]').click();await visit.waitForURL(copy+'/native-checkout');
  await panel.locator('#operational-form [name=revision]').fill(String(revision));await submit('#operational-form','button[value=authorize]','operational');
  const recovered=visit.waitForResponse(r=>r.url()===decisionUrl);await visit.goto(copy+'/lp');assert.equal((await (await recovered).json()).action,'REPLACE_CONVERSION');await visit.waitForTimeout(80);await visit.locator('[data-anticlone-point=checkout01]').click();await visit.waitForURL(original+'/checkout-approved');
  await visit.goto(original+'/lp');await visit.waitForTimeout(100);await visit.locator('[data-anticlone-point=checkout01]').click();await visit.waitForURL(original+'/native-checkout');
  assert.equal(messages.length,1);assert.equal((await db.query('SELECT count(*)::int n FROM incidents WHERE project_id=$1',[project])).rows[0].n,1);
  assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'panel fits viewport');
  await mkdir('test-results/operational-journey',{recursive:true});await panel.screenshot({path:`test-results/operational-journey/panel-${width}.png`,fullPage:true});
  await context.close();
 }finally{process.env=saved;await browser?.close();if(admin?.listening)await new Promise<void>(r=>admin!.close(()=>r()));if(gateway?.listening)await new Promise<void>(r=>gateway!.close(()=>r()));await new Promise<void>(r=>smtp.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(directory,{recursive:true,force:true});}
});
