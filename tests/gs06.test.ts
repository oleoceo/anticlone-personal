import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { chromium } from 'playwright';

test('GS06 integration: persisted policy, controlled LOW and original', {timeout:60000}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  for (const file of ['001_initial','002_alerts','003_projects','004_observation_sources','005_canaries','006_page_redirect']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  const project='gs06_'+crypto.randomUUID();
  const fixture=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<h1>site</h1><a href="/next">next</a><script src="http://127.0.0.1:3000/runtime.js"></script>'));
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening'); const address=fixture.address(); if (!address || typeof address==='string') throw Error('address');
  const original=`http://127.0.0.1:${address.port}`, clone=`http://localhost:${address.port}`;
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,original]);
  await db.query('INSERT INTO page_redirect_policies VALUES($1,1,true,$2)',[project,original+'/approved']);
  const app=spawn(process.execPath,['dist/apps/server.js'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PROJECT_ID:project,SMTP_PORT:'25252',PORT:'3000',LAB_CONTROLLED_ORIGIN:clone,LAB_CONTROLLED_RISK:'LOW'},stdio:['ignore','ignore','inherit']});
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let ready=false; for(let n=0;n<100;n++){try { if((await fetch('http://127.0.0.1:3000/runtime.js')).ok){ready=true;break;} }catch {} await new Promise(r=>setTimeout(r,100));} assert.ok(ready);
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']}); const page=await browser.newPage();
    await page.goto(original+'/original'); await page.waitForTimeout(400); assert.equal(page.url(),original+'/original');
    await page.goto(clone+'/clone'); await page.waitForURL(original+'/approved'); await page.waitForTimeout(400); assert.equal(page.url(),original+'/approved');
    let observed=false; for(let n=0;n<50;n++){if((await db.query('SELECT id FROM incidents WHERE project_id=$1',[project])).rowCount){observed=true;break;} await new Promise(r=>setTimeout(r,100));} assert.ok(observed);
    await db.query('INSERT INTO page_redirect_policies VALUES($1,2,false,$2)',[project,original+'/approved']);
    await page.goto(clone+'/clone'); await page.waitForTimeout(400); assert.equal(page.url(),clone+'/clone');
    const response=await fetch('http://127.0.0.1:3000/entry-decision?risk=LOW&destination=http://evil.test/',{headers:{origin:clone}}); assert.equal(response.status,404);
  } finally {
    if(browser) await browser.close(); app.kill('SIGTERM'); if(app.exitCode===null && app.signalCode===null) await once(app,'exit');
    await db.query('DELETE FROM incidents WHERE project_id=$1',[project]); await db.query('DELETE FROM observations WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]); await db.query('DELETE FROM observation_days WHERE project_id=$1',[project]); await db.query('DELETE FROM projects WHERE id=$1',[project]); await db.end(); await new Promise<void>(r=>fixture.close(()=>r()));
  }
});
