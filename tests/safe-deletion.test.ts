import { projectPurgePreview } from '../apps/project-purge-preview.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { TOTP, Secret } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';
import { managePages } from '../apps/protected-pages.js';
import { publishPagePolicy } from '../apps/protection-admin.js';
import { saveDraft, activatePolicy } from '../apps/protection-policy.js';
import { publishCtaPolicy } from '../apps/cta-policy.js';
import { importInventory, approveDestination, mapPoint, reviewPoint, selectObservation, approveCommercial } from '../apps/cta-inventory.js';
import { enableInstallation, disableInstallation } from '../apps/installation.js';
import { configureHealth } from '../apps/health-alerts.js';
import { recordCheckout } from '../apps/checkout-webhook.js';
import { DeletedProjectConflict } from '../apps/admin-project-write.js';
import { operationallyEligible } from '../apps/operational-eligibility.js';

const allocation={PAID_ATTRIBUTED:0,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0};
test('safe deletion: project write guards, isolated LP closure, URL reuse and honest physical blockers', {timeout:60000}, async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='safe_delete_'+randomUUID().replaceAll('-',''),external=schema+'_external';
 await root.query(`CREATE SCHEMA ${schema}`);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,server:ReturnType<typeof createAdminServer>|undefined;
 const origin='http://localhost:12345';
 const draft={enabled:true,stealth:true,approved_destination:origin+'/checkout',allocation};
 const inventory={surface:'main',candidates:[{marker:'abcdefgh',kind:'a',parent:'div',ordinal:1,url:origin+'/checkout'}]};
 const sale=(id:string)=>Buffer.from(JSON.stringify({event_id:id,sale_id:id,amount_minor:1200,currency:'BRL',occurred_at:'2026-11-09T12:00:00.000Z'}));
 const pageRow=async(id:string)=>(await db.query('SELECT * FROM protected_pages WHERE id=$1',[id])).rows[0];
 const rows=async(table:string,project:string)=>(await db.query('SELECT to_jsonb(t) AS item FROM '+table+' t WHERE project_id=$1 ORDER BY to_jsonb(t)::text',[project])).rows.map(r=>r.item);
 try {
  for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','017_notification_settings','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','023_cta_commercial','025_installation_signals','026_degradation','027_canary_degradation','028_health_alerts','029_health_settings_history','030_infrastructure_dns','031_investigation_timeline','032_incident_status_audit','033_clone_delivery_attempts','035_checkout_receipts','036_cta_surface_policies','037_protected_pages','038_page_url_review','039_page_policy_bindings','040_page_policy_approvals','041_page_entry_activation','042_page_installation_signals','043_lifecycle','044_notification_lifecycle','045_project_lifecycle_audit','046_page_deletion']) await db.query((await readFile(`infra/${file}.sql`,'utf8')).replace(String.fromCharCode(65279),''));
  await db.query("INSERT INTO projects(id,name,origin) VALUES('health','Health',$1),('finance','Finance',$1)",[origin]);
  const a=randomUUID(),b=randomUUID(),f=randomUUID(),oldInstallation=randomUUID();
  for(const [id,project,name,path,installation] of [[a,'health','LP A','/health-a',oldInstallation],[b,'health','LP B','/health-b',randomUUID()],[f,'finance','Finance LP','/finance',randomUUID()]]) {
   await db.query('INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,$2,$3,$4)',[id,project,installation,name]);
   await db.query('INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,$3)',[id,origin,path]);
  }
  for(const project of ['health','finance']) {await enableInstallation(db,project);await configureHealth(db,project,false,60,true);await publishPagePolicy(db,project,draft);await publishCtaPolicy(db,project,{enabled:true,surface:'main',pathname:project==='health'?'/health-a':'/finance',allocation});await importInventory(db,project,inventory);await recordCheckout(db,project,sale(project));}
  const point=(await db.query("SELECT id FROM cta_points WHERE project_id='health'")).rows[0].id;
  const destination=(await approveDestination(db,'health',{offer:'offer',url:origin+'/checkout'})).id;
  await mapPoint(db,'health',{offer:'offer',pointId:point,destinationId:destination});
  const signal=(await db.query("SELECT id,capture_id FROM cta_observations WHERE project_id='health' ORDER BY id DESC LIMIT 1")).rows[0];
  const p=await pageRow(a);
  await managePages(db,{project:'health',page:a,action:'approve',generation:p.url_generation,configGeneration:p.config_generation,entryVersion:1,ctaVersions:[]});
  await db.query("INSERT INTO page_cta_policy_bindings(project_id,page_id,surface,version) VALUES('health',$1,'main',1)",[a]);
  await db.query("INSERT INTO page_installation_signals(project_id,page_id,source) VALUES('health',$1,'core'),('health',$2,'core'),('finance',$3,'core')",[a,b,f]);
  const untouchedB=await pageRow(b),untouchedF=await pageRow(f);
  const history=await rows('page_policy_approvals','health'),finances=await rows('checkout_receipts','health'),cta=await rows('cta_points','health');
  await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL);CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
  const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  server=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr && typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
  assert.equal((await fetch(base+'/admin/ui/pages',{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({project:'health',page:a,action:'delete-page'})})).status,403);
  browser=await chromium.launch();const page=await browser.newPage();await page.goto(base+'/admin/ui/');await page.locator('#login [name=password]').fill('password');await page.locator('#login [name=code]').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await page.getByRole('button',{name:'Entrar',exact:true}).click();
  const form=page.locator('#page-deletion-form');await form.waitFor({state:'visible'});
  const post=(body:unknown,csrf=true)=>page.evaluate(async({body,csrf})=>{const b=await (await fetch('/admin/ui/bootstrap')).json();const r=await fetch('/admin/ui/pages',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-csrf-token':b.csrf}:{})},body:JSON.stringify(body)});return {status:r.status,body:r.ok?await r.json():null};},{body,csrf});
  assert.equal((await post({project:'health',page:a,action:'preview-delete-page'},false)).status,403);
  await form.locator('[name=project]').fill('health');await form.locator('[name=page]').fill(a);
  const response=page.waitForResponse(r=>r.url().endsWith('/admin/ui/pages'));await form.getByRole('button',{name:'Consultar dependencias da LP'}).click();const preview=await (await response).json();
  assert.equal(preview.remove.protected_page_urls,1);assert.equal(preview.retain.page_policy_approvals,1);assert.equal(preview.historicalPageAnchorRetained,true);
  const wrong={project:'health',page:a,action:'delete-page',version:preview.version,confirmation:'DELETE PAGE finance/wrong',justification:'Controlled page deletion'};
  assert.equal((await post(wrong)).status,400);
  assert.equal((await post({...wrong,project:'finance',confirmation:preview.confirmation})).status,400);
  await form.locator('[name=confirmation]').fill(preview.confirmation);await form.locator('[name=justification]').fill('Controlled page deletion');
  const deleted=page.waitForResponse(r=>r.url().endsWith('/admin/ui/pages'));await form.getByRole('button',{name:'Excluir LP definitivamente'}).click();assert.equal((await deleted).status(),200);
  assert.ok((await pageRow(a)).deleted_at);assert.equal(await operationallyEligible(db,'health',a),false);assert.equal(await operationallyEligible(db,'health',b),true);assert.equal(await operationallyEligible(db,'finance',f),true);
  assert.deepEqual(await pageRow(b),untouchedB);assert.deepEqual(await pageRow(f),untouchedF);
  assert.deepEqual(await rows('page_policy_approvals','health'),history);assert.deepEqual(await rows('checkout_receipts','health'),finances);assert.deepEqual(await rows('cta_points','health'),cta);
  assert.equal((await db.query('SELECT count(*)::int n FROM page_installation_signals WHERE page_id=$1',[b])).rows[0].n,1);
  assert.equal((await post({project:'health',page:a,action:'resume-page'})).status,409);
  assert.equal((await post({project:'health',page:a,action:'add-url',url:origin+'/health-a'})).status,409);
  const replacement=await post({project:'health',action:'create',name:'Replacement LP',url:origin+'/health-a'});assert.equal(replacement.status,200);const replacementId=replacement.body.page as string;
  assert.notEqual(replacementId,a);assert.notEqual(replacement.body.installation,oldInstallation);
  assert.equal((await post({project:'finance',action:'create',name:'Duplicate URL',url:origin+'/health-a'})).status,409);
  const stalePreview=(await post({project:'health',page:replacementId,action:'preview-delete-page'})).body;
  assert.equal((await post({project:'health',page:replacementId,action:'add-url',url:origin+'/replacement-extra'})).status,200);
  assert.equal((await post({project:'health',page:replacementId,action:'delete-page',version:stalePreview.version,confirmation:stalePreview.confirmation,justification:'Stale dependencies must reject'})).status,409);
  const rp=(await post({project:'health',page:replacementId,action:'preview-delete-page'})).body;
  const concurrent=await Promise.all([post({project:'health',page:replacementId,action:'delete-page',version:rp.version,confirmation:rp.confirmation,justification:'Concurrent removal one'}),post({project:'health',page:replacementId,action:'delete-page',version:rp.version,confirmation:rp.confirmation,justification:'Concurrent removal two'})]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.deepEqual(await pageRow(b),untouchedB);assert.deepEqual(await pageRow(f),untouchedF);
  // Failure of the mandatory deletion audit must restore URLs, state and bindings.
  await db.query(`CREATE FUNCTION reject_page_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;CREATE TRIGGER reject_page_deletion BEFORE INSERT ON page_deletion_audit FOR EACH ROW EXECUTE FUNCTION reject_page_deletion()`);
  const bp=(await post({project:'health',page:b,action:'preview-delete-page'})).body;
  assert.equal((await post({project:'health',page:b,action:'delete-page',version:bp.version,confirmation:bp.confirmation,justification:'Must roll back'})).status,503);assert.deepEqual(await pageRow(b),untouchedB);
  await db.query('DROP TRIGGER reject_page_deletion ON page_deletion_audit;DROP FUNCTION reject_page_deletion()');
  // Lifecycle lock wins first; a real policy publication must revalidate after commit.
  const blocker=await db.connect();let writing:Promise<unknown>|undefined;
  const beforeVersions=await rows('protection_policy_versions','health');
  try {
   await blocker.query('BEGIN');await blocker.query("UPDATE projects SET lifecycle_state='ARCHIVED',deleted_at=clock_timestamp() WHERE id='health'");
   writing=publishPagePolicy(db,'health',draft);const rejected=assert.rejects(writing,DeletedProjectConflict);
   const deadline=Date.now()+5000;let waiting=false;
   do{waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,to_jsonb(p)%FOR UPDATE%') AS waiting")).rows[0].waiting;}while(!waiting && Date.now()<deadline);
   assert.ok(waiting);await publishPagePolicy(db,'finance',draft);await blocker.query('COMMIT');await rejected;
  }finally{await blocker.query('ROLLBACK');blocker.release();await writing?.catch(()=>{});}
  assert.deepEqual(await rows('protection_policy_versions','health'),beforeVersions);
  // Live LPs in a deleted project reject both transitions without writes.
  const beforePage=await pageRow(b);
  for(const action of ['pause-page','resume-page']) assert.equal((await post({project:'health',page:b,action})).status,409);
  assert.deepEqual(await pageRow(b),beforePage);
  assert.equal((await post({project:'health',action:'project-state'})).status,200);
  for(const action of ['pause-page','resume-page']) assert.equal((await post({project:'finance',page:f,action})).status,200);
  assert.deepEqual(await pageRow(f),{...untouchedF,deletion_version:(BigInt(untouchedF.deletion_version)+2n).toString()});
  const mutations=[()=>saveDraft(db,'health',draft),()=>activatePolicy(db,'health',1),()=>publishCtaPolicy(db,'health',{enabled:true,surface:'main',pathname:'/health-a',allocation}),()=>importInventory(db,'health',inventory),()=>approveDestination(db,'health',{offer:'offer',url:origin+'/checkout'}),()=>mapPoint(db,'health',{offer:'offer',pointId:point,destinationId:destination}),()=>reviewPoint(db,'health',{pointId:point,destinationId:destination,observationId:signal.id}),()=>selectObservation(db,{project:'health',captureId:signal.capture_id,destinationId:destination,observationId:signal.id,offer:'offer',pointId:point,surface:'main'}),()=>approveCommercial(db,{project:'health',captureId:signal.capture_id,destinationId:destination,observationId:signal.id,pointId:point,surface:'main',amount:100,currency:'BRL',version:0}),()=>enableInstallation(db,'health'),()=>disableInstallation(db,'health'),()=>configureHealth(db,'health',true,60,true)];
  for(const mutate of mutations)await assert.rejects(mutate,DeletedProjectConflict);
  assert.equal((await post({project:'health',page:a,action:'preview-delete-page'})).status,200,'consultation remains available after project tombstone');
  await saveDraft(db,'finance',draft);await importInventory(db,'finance',inventory);await configureHealth(db,'finance',true,60,true);await recordCheckout(db,'finance',sale('finance-still-operates'));
  assert.equal((await db.query("SELECT count(*)::int n FROM checkout_receipts WHERE project_id='finance'")).rows[0].n,2);
  await root.query(`CREATE SCHEMA ${external}`);await root.query(`CREATE TABLE ${external}.external_audit(id int PRIMARY KEY,owner text REFERENCES ${schema}.projects(id));INSERT INTO ${external}.external_audit VALUES(1,'health')`);
  const inspected=await projectPurgePreview(db,{project:'health',action:'preview-purge-project'});assert.equal(inspected.executed,false);
  // An empty/foreign first search_path schema must not hide the projects schema.
  const shadow=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${external},${schema}`});
  try {const projected=await projectPurgePreview(shadow,{project:'health',action:'preview-purge-project'});assert.ok(projected.inventory.some(v=>v.schema===schema&&v.table==='page_policy_approvals'&&v.rows===1));}finally{await shadow.end();}
  const purgeResponse=await post({project:'health',action:'preview-purge-project'});assert.equal(purgeResponse.status,200);const purge=purgeResponse.body;
  assert.equal(purge.physicalDeletionAvailable,false);assert.equal(purge.executed,false);assert.ok(purge.blockers.some((v:{table:string;reason:string})=>v.table==='page_policy_approvals'&&v.reason.includes('Immutable')));assert.ok(purge.blockers.some((v:{table:string})=>v.table===external+'.external_audit'));
  assert.ok(purge.foreignKeys.some((v:{schema:string})=>v.schema===external));assert.ok(purge.inventory.some((v:{table:string;scope:string;rows:number})=>v.table==='page_policy_approval_entries'&&v.scope==='PROJECT_KEY'&&v.rows===1));
  assert.equal((await post({project:'health',action:'purge-project',version:'999',confirmation:purge.confirmation,justification:'Blocked physical test'})).status,409);
  const attempted=await post({project:'health',action:'purge-project',version:purge.version,confirmation:purge.confirmation,justification:'Blocked physical test'});assert.equal(attempted.status,409);
  assert.equal((await db.query("SELECT count(*)::int n FROM projects WHERE id='health'")).rows[0].n,1);assert.deepEqual(await rows('page_policy_approvals','health'),history);assert.deepEqual(await rows('checkout_receipts','health'),finances);
  assert.ok(purge.backupPolicy.includes('backups'));
  const current=(await db.query("SELECT lifecycle_version FROM projects WHERE id='health'")).rows[0].lifecycle_version;
  assert.equal((await post({project:'health',action:'restore-project',version:current,justification:'Authorized synthetic restoration'})).status,200);assert.equal(await operationallyEligible(db,'health'),false);
 }finally{if(browser)await browser.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await db.end();await root.query(`DROP SCHEMA IF EXISTS ${external} CASCADE`);await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
