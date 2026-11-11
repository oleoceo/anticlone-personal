import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { chromium } from 'playwright';
import { checkoutWebhook, checkoutMetrics } from '../apps/checkout-webhook.js';
import { createAdminServer } from '../apps/admin-auth.js';

test('GS14 authenticated generic checkout persists exactly one sale across retries/restart and isolates projects',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const parent=new Pool({connectionString:process.env.TEST_DATABASE_URL}), schema='checkout_'+randomUUID().replaceAll('-','');
  await parent.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const secret='ab'.repeat(32), clock=Date.now(), timestamp=String(Math.floor(clock/1000));
  let server:Server|undefined, admin:Server|undefined;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let adminClock=clock;
  const start=async(project='one',enabled=true)=>{
    const handler=checkoutWebhook(db,project,enabled?{CHECKOUT_WEBHOOK_SECRET:secret}:{},()=>clock);
    server=createServer((req,res)=>{if(!handler(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');
    await once(server,'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const close=async()=>{if(server){server.close();await once(server,'close');server=undefined;}};
  const sale={event_id:'evt_1',sale_id:'sale_1',amount_minor:1999,currency:'BRL',occurred_at:'2026-11-06T00:00:00.000Z'};
  let base='';
  const send=(value:unknown=sale,ts=timestamp,override?:Record<string,string>)=>{
    const body=JSON.stringify(value),signature=createHmac('sha256',Buffer.from(secret,'hex')).update(ts+'.'+body).digest('hex');
    return fetch(base+'/checkout-webhook',{method:'POST',headers:{'content-type':'application/json','x-checkout-timestamp':ts,'x-checkout-signature':signature,...override},body});
  };
  try {
    await db.query(await readFile('infra/003_projects.sql','utf8'));
    await db.query("ALTER TABLE projects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'");
    await db.query(await readFile('infra/035_checkout_receipts.sql','utf8'));
    await db.query("INSERT INTO projects VALUES('one','One','https://one.test'),('two','Two','https://two.test')");
    base=await start();
    assert.equal((await send(sale,timestamp,{'x-checkout-signature':'00'.repeat(32)})).status,401);
    assert.equal((await send(sale,String(Number(timestamp)-301))).status,401);
    assert.equal((await send(sale,timestamp,{origin:'https://hostile.test'})).status,403);
    assert.equal((await send({...sale,customer_email:'private@example.test'})).status,400);
    assert.equal((await send({...sale,amount_minor:1.5})).status,400);
    assert.equal((await send({...sale,occurred_at:'2026-02-30T00:00:00.000Z'})).status,400);
    assert.equal((await send({...sale,sale_id:'x'.repeat(3000)})).status,413);
    assert.equal((await db.query('SELECT count(*)::int n FROM checkout_sales')).rows[0].n,0);
    await db.query("UPDATE projects SET lifecycle_state='PAUSED' WHERE id='one'");
    assert.equal((await send()).status,503);
    assert.equal((await db.query('SELECT count(*)::int n FROM checkout_receipts')).rows[0].n,0);
    await db.query("UPDATE projects SET lifecycle_state='ACTIVE' WHERE id='one'");
    const responses=await Promise.all([send(),send(),send()]);
    assert.deepEqual(responses.map(r=>r.status),[200,200,200]);
    const results=await Promise.all(responses.map(r=>r.json()));
    assert.equal(results.filter(r=>!r.duplicate).length,1);
    assert.equal((await send({...sale,amount_minor:2000})).status,409);
    assert.equal((await send({...sale,event_id:'evt_2',amount_minor:2000})).status,409);
    assert.equal((await send({...sale,event_id:'evt_2'})).status,200);
    await close(); base=await start();
    assert.equal((await (await send()).json()).duplicate,true);
    assert.equal((await db.query('SELECT count(*)::int n FROM checkout_sales')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int n FROM checkout_receipts')).rows[0].n,2);
    const one=await checkoutMetrics(db,'one');
    assert.deepEqual(one.currencies,[{currency:'BRL',reported_sales:1,reported_amount_minor:'1999'}]);
    assert.equal(one.clicks,null); assert.equal(one.recovered_revenue,null); assert.equal(one.attribution,'UNVERIFIED');
    assert.deepEqual((await checkoutMetrics(db,'two')).currencies,[]);
    await close(); base=await start('two');
    assert.equal((await (await send()).json()).duplicate,false);
    assert.equal((await checkoutMetrics(db,'two')).currencies[0].reported_sales,1);
    // The authenticated admin API also enforces its existing origin boundary.
    await db.query('CREATE TABLE admin_totp_replay(factor_id text PRIMARY KEY,last_counter bigint NOT NULL); CREATE TABLE admin_totp_codes(factor_id text,digest text,valid_until bigint,PRIMARY KEY(factor_id,digest))');
    const salt='0123456789abcdef0123456789abcdef',totpSecret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await db.query((await readFile('infra/017_notification_settings.sql','utf8')).replace(/^\uFEFF/,''));
    admin=createAdminServer(`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`,totpSecret,db,()=>adminClock).listen(0,'127.0.0.1');
    await once(admin,'listening'); const adminBase=`http://127.0.0.1:${(admin.address() as AddressInfo).port}/admin`;
    assert.equal((await fetch(adminBase+'/projects/one/checkout-metrics')).status,401);
    const login=await fetch(adminBase+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(totpSecret)}).generate({timestamp:adminClock})})});
    assert.equal(login.status,200); const {token}=await login.json();
    const response=await fetch(adminBase+'/projects/one/checkout-metrics',{headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.status,200); assert.deepEqual(await response.json(),one);
    assert.equal((await fetch(adminBase+'/projects/one/checkout-metrics',{headers:{authorization:`Bearer ${token}`,origin:'https://hostile.test'}})).status,403);
    assert.equal(JSON.stringify(one).includes(secret),false);
    adminClock+=30000;
    browser=await chromium.launch();
    const page=await browser.newPage();
    await page.goto(adminBase+'/ui/');
    await page.getByLabel('Senha administrativa').fill('password');
    await page.getByLabel('Código TOTP').fill(new TOTP({secret:Secret.fromBase32(totpSecret)}).generate({timestamp:adminClock}));
    await page.getByRole('button',{name:'Entrar',exact:true}).click();
    await page.getByLabel('Projeto do checkout').fill('one');
    await page.getByRole('button',{name:'Consultar vendas reportadas',exact:true}).click();
    await page.locator('#checkout-sales').getByText('BRL: 1 venda(s) reportada(s), 1999 unidades menores da moeda. Não é receita recuperada.',{exact:true}).waitFor();
    await page.getByLabel('Projeto do checkout').fill('missing');
    await page.getByRole('button',{name:'Consultar vendas reportadas',exact:true}).click();
    await page.getByText('Nenhuma venda reportada no projeto missing.',{exact:true}).waitFor();
    assert.equal(await page.locator('#checkout-sales').textContent(),'');
    // Preserve the real authenticated HTTP response, delaying only its Promise
    // resolution so a completed request for another project can overtake it.
    await page.evaluate(()=>{
      const state=window as typeof window & {checkoutRaceStarted?:boolean;checkoutRaceCompleted?:boolean;checkoutRaceRelease?:()=>void};
      const originalFetch=window.fetch.bind(window);
      let release:()=>void=()=>{};
      const held=new Promise<void>(resolve=>{release=resolve;});
      state.checkoutRaceRelease=release;
      window.fetch=async(input,init)=>{
        const response=await originalFetch(input,init);
        if(typeof input==='string' && input.endsWith('/checkout-metrics') && JSON.parse(String(init?.body??'{}')).project==='one') {
          if(response.status!==200) throw Error('expected real authenticated checkout response');
          state.checkoutRaceStarted=true;
          await held;
          const json=response.json.bind(response);
          response.json=async()=>{const result=await json();setTimeout(()=>{state.checkoutRaceCompleted=true;window.fetch=originalFetch;},0);return result;};
        }
        return response;
      };
    });
    await page.getByLabel('Projeto do checkout').fill('one');
    await page.getByRole('button',{name:'Consultar vendas reportadas',exact:true}).click();
    await page.waitForFunction(()=>!!(window as typeof window & {checkoutRaceStarted?:boolean}).checkoutRaceStarted);
    await page.getByLabel('Projeto do checkout').fill('missing');
    assert.equal(await page.locator('#checkout-sales').textContent(),'');
    await page.getByRole('button',{name:'Consultar vendas reportadas',exact:true}).click();
    await page.getByText('Nenhuma venda reportada no projeto missing.',{exact:true}).waitFor();
    await page.evaluate(()=>(window as typeof window & {checkoutRaceRelease:()=>void}).checkoutRaceRelease());
    await page.waitForFunction(()=>!!(window as typeof window & {checkoutRaceCompleted?:boolean}).checkoutRaceCompleted);
    assert.equal(await page.locator('#checkout-status').textContent(),'Nenhuma venda reportada no projeto missing.');
    assert.equal(await page.locator('#checkout-sales').textContent(),'');
    const csrfDenied=await page.evaluate(async()=>{const result=await fetch('/admin/ui/checkout-metrics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:'one'})});return result.status;});
    assert.equal(csrfDenied,403);
    await close(); base=await start('one',false); assert.equal((await send()).status,404);
    assert.throws(()=>checkoutWebhook(db,'one',{CHECKOUT_WEBHOOK_SECRET:'short'}));
    assert.throws(()=>checkoutWebhook(db,'one',{CHECKOUT_WEBHOOK_SECRET:'a'.repeat(65)}),'odd-length hex keys must not be silently truncated');
  } finally {
    await browser?.close(); await close(); if(admin){admin.close();await once(admin,'close');}
    await db.end(); await parent.query(`DROP SCHEMA ${schema} CASCADE`); await parent.end();
  }
});
