import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { TOTP, Secret } from 'otpauth';
import { SMTPServer } from 'smtp-server';
import { createAdminServer } from '../apps/admin-auth.js';
import { operationallyEligible } from '../apps/operational-eligibility.js';
import { recordCheckout } from '../apps/checkout-webhook.js';
import { observe } from '../apps/detection.js';
import { deliverOne } from '../apps/alerts.js';

test('GS15: authenticated archive, paused restore and confirmed logical deletion preserve project records', {timeout:60000}, async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='archive_lab_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined, server:ReturnType<typeof createAdminServer>|undefined;
  let mails=0;
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){stream.resume();stream.on('end',()=>{mails++;callback();});}});
  const smtpServer=smtp.listen(0,'127.0.0.1');await once(smtpServer,'listening');const smtpAddress=smtpServer.address();assert.ok(smtpAddress && typeof smtpAddress!=='string');
  const sale=(id:string)=>Buffer.from(JSON.stringify({event_id:id,sale_id:id,amount_minor:1000,currency:'BRL',occurred_at:'2026-11-09T12:00:00.000Z'}));
  const state=async(id='health')=>(await db.query('SELECT id,name,lifecycle_state,lifecycle_version,deleted_at FROM projects WHERE id=$1',[id])).rows[0];
  const snapshot=async(id:string)=>{
    const data:Record<string,unknown>={};
    for(const table of ['protected_pages','incidents','alert_outbox','checkout_sales','checkout_receipts']) {
      data[table]=table==='alert_outbox' ? (await db.query('SELECT a.* FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 ORDER BY a.id',[id])).rows : (await db.query('SELECT * FROM '+table+' WHERE project_id=$1',[id])).rows;
    }
    return data;
  };
  try {
    for(const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect','007_protection_policy','008_traffic_observations','009_risk_assessments','024_risk_evidence','010_policy_allocation','011_cta_inventory','022_cta_capture_selection','012_cta_policy','013_cta_review','014_cta_drift_alerts','015_cta_alert_deliveries','016_cta_local_smtp','018_notification_budget','019_alert_outbox_expiry','020_cta_delivery_expiry','021_notification_intent_reconciliation','023_cta_commercial','025_installation_signals','035_checkout_receipts','036_cta_surface_policies','037_protected_pages','038_page_url_review','039_page_policy_bindings','040_page_policy_approvals','041_page_entry_activation','042_page_installation_signals','043_lifecycle','044_notification_lifecycle','045_project_lifecycle_audit']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('health','Health','http://health.test'),('finance','Finance','http://finance.test')");
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL); CREATE TABLE admin_totp_codes(factor_id text NOT NULL,digest text NOT NULL,valid_until bigint NOT NULL,PRIMARY KEY(factor_id,digest))');
    const pageId=randomUUID(), installationId=randomUUID();await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'health',$2,'Health page')",[pageId,installationId]);
    for(const id of ['health','finance']) {await recordCheckout(db,id,sale(id));await observe(db,id,`http://${id}.test`,`http://${id}-copy.test`);}
    const healthBefore=await snapshot('health'), financeBefore=await snapshot('finance');
    const salt='0123456789abcdef0123456789abcdef',secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    server=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,secret,db).listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr && typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
    assert.equal((await fetch(base+'/admin/ui/pages',{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({project:'health',action:'archive-project',version:'0',justification:'Archive fixture'})})).status,403);
    browser=await chromium.launch();const page=await browser.newPage();await page.goto(base+'/admin/ui/');
    await page.getByLabel('Senha administrativa').fill('password');await page.locator('#login [name=code]').fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());await page.getByRole('button',{name:'Entrar',exact:true}).click();
    const form=page.locator('#project-lifecycle-form');await form.waitFor({state:'visible'});
    const post=(body:unknown,csrf=true)=>page.evaluate(async({body,csrf})=>{
      const auth=await (await fetch('/admin/ui/bootstrap')).json();
      const response=await fetch('/admin/ui/pages',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-csrf-token':auth.csrf}:{})},body:JSON.stringify(body)});
      return {status:response.status,body:response.ok ? await response.json() : null};
    },{body,csrf});
    assert.equal((await post({project:'health',action:'archive-project',version:'0',justification:'Archive fixture'},false)).status,403);
    await form.locator('[name=project]').fill('health');await form.locator('[name=justification]').fill('Archive laboratory fixture');
    const click=async(label:string)=>{const response=page.waitForResponse(r=>r.url().endsWith('/admin/ui/pages'));await form.getByRole('button',{name:label,exact:true}).click();return response;};
    assert.equal((await click('Consultar ciclo')).status(),200);
    assert.equal(await form.locator('[name=version]').inputValue(),'0');
    assert.equal((await click('Arquivar projeto')).status(),200);
    assert.equal((await state()).lifecycle_state,'ARCHIVED');assert.equal(await operationallyEligible(db,'health',pageId),false);assert.equal(await operationallyEligible(db,'finance'),true);
    await assert.rejects(recordCheckout(db,'health',sale('health-blocked')),/project unavailable/);
    await deliverOne(db,'health',smtpAddress.port);assert.equal(mails,0);
    const preview=await (await click('Previa da exclusao logica')).json() as {version:string;confirmation:string;inventory:Record<string,number>;physicalDeletionAvailable:boolean};
    assert.equal(preview.version,'1');assert.equal(preview.confirmation,'health:Health');assert.equal(preview.inventory.checkout_receipts,1);assert.equal(preview.physicalDeletionAvailable,false);
    await form.locator('[name=confirmation]').fill('finance:Health');assert.equal((await click('Excluir logicamente')).status(),400);assert.equal((await state()).lifecycle_version,'1');
    await form.locator('[name=confirmation]').fill(preview.confirmation);assert.equal((await click('Excluir logicamente')).status(),200);
    assert.ok((await state()).deleted_at);assert.equal((await state()).lifecycle_state,'ARCHIVED');
    assert.equal((await post({project:'health',action:'resume-project'})).status,409);
    assert.equal((await post({project:'health',action:'create',name:'Blocked change',url:'http://localhost/new'})).status,409);
    assert.equal((await post({project:'health',action:'delete-project',version:'1',justification:'Repeated old confirmation',confirmation:'health:Health'})).status,409);
    assert.deepEqual(await snapshot('health'),healthBefore);assert.deepEqual(await snapshot('finance'),financeBefore);
    assert.equal((await click('Restaurar projeto pausado')).status(),200);
    assert.equal((await state()).lifecycle_state,'PAUSED');assert.equal((await state()).deleted_at,null);assert.equal((await state()).lifecycle_version,'3');
    assert.equal(await operationallyEligible(db,'health',pageId),false);
    assert.equal((await post({project:'health',action:'resume-project'})).status,200);assert.equal((await state()).lifecycle_version,'4');
    await deliverOne(db,'health',smtpAddress.port);assert.equal(mails,0);
    assert.equal((await db.query("SELECT hold_state FROM notification_lifecycle_queue WHERE project_id='health'")).rows[0].hold_state,'REVIEW_REQUIRED');
    await recordCheckout(db,'finance',sale('finance-second'));assert.equal((await db.query("SELECT count(*)::int n FROM checkout_receipts WHERE project_id='finance'")).rows[0].n,2);
    const racing=await Promise.all([post({project:'health',action:'archive-project',version:'4',justification:'Concurrent archive one'}),post({project:'health',action:'archive-project',version:'4',justification:'Concurrent archive two'})]);
    assert.deepEqual(racing.map(r=>r.status).sort(),[200,409]);assert.equal((await state()).lifecycle_version,'5');
    assert.equal((await post({project:'health',action:'restore-project',version:'4',justification:'Stale restore'})).status,409);
    assert.equal((await post({project:'health',action:'restore-project',version:'5',justification:'Current restore'})).status,200);
    const audit=(await db.query("SELECT * FROM project_lifecycle_audit WHERE project_id='health' ORDER BY id")).rows;
    assert.equal(audit.length,6);assert.deepEqual(audit.map(r=>r.current_version),['1','2','3','4','5','6']);assert.equal((await state('finance')).lifecycle_version,'0');
    await db.query(`CREATE FUNCTION reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON project_lifecycle_audit FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_audit()`);
    assert.equal((await post({project:'health',action:'archive-project',version:'6',justification:'Must rollback without audit'})).status,503);
    assert.equal((await state()).lifecycle_state,'PAUSED');assert.equal((await state()).lifecycle_version,'6');
    assert.equal((await db.query("SELECT count(*)::int n FROM project_lifecycle_audit WHERE project_id='health'")).rows[0].n,6);
    assert.deepEqual(await snapshot('health'),healthBefore);
    await db.query('DROP TRIGGER reject_lifecycle_audit ON project_lifecycle_audit; DROP FUNCTION reject_lifecycle_audit()');
    // Each mutation must wait on the project state and re-check a concurrent tombstone.
    for(const mutation of [
      {action:'create',name:'Concurrent page',url:'http://localhost/racing'},
      {action:'add-url',page:pageId,url:'http://localhost/racing'},
      {action:'remove-url',page:pageId,url:'http://localhost/racing'},
      {action:'approve',page:pageId,generation:'0',configGeneration:'0',entryVersion:null,ctaVersions:[1]}
    ]) {
      const blocker=await db.connect();let pending:ReturnType<typeof post>|undefined;
      try {
        await blocker.query('BEGIN');await blocker.query("UPDATE projects SET lifecycle_state='ARCHIVED',deleted_at=clock_timestamp() WHERE id='health'");
        pending=post({project:'health',...mutation});
        const deadline=Date.now()+5000;let waiting=false;
        do {waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT to_jsonb(p)%deleted_at%FOR UPDATE%') AS waiting")).rows[0].waiting;} while(!waiting && Date.now()<deadline);
        assert.ok(waiting,mutation.action+' locks the project before writing');
        await blocker.query('COMMIT');assert.equal((await pending).status,409);
      } finally {await blocker.query('ROLLBACK');blocker.release();await pending;}
      const version=(await state()).lifecycle_version;
      assert.equal((await post({project:'health',action:'restore-project',version,justification:'Restore synthetic race fixture'})).status,200);
      assert.deepEqual(await snapshot('health'),healthBefore);
    }
  } finally {if(browser)await browser.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await new Promise<void>(resolve=>smtp.close(()=>resolve()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});
