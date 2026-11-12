import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,copyFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {chromium,type Page} from 'playwright';
import {upgradeLaboratory} from '../apps/versioned-upgrade.js';
import {saveOperationalBundle,readOperationalBundle} from '../apps/operational-bundle.js';
import {backup,restore} from '../apps/recovery.js';
import {compilePreviousCode} from './previous-code.js';
import {managePages} from '../apps/protected-pages.js';

test('Front3: checksummed versioned upgrade, atomic failure, real baseline restore, operational bundle and code rollback',{timeout:180000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const suffix=randomUUID().replaceAll('-',''),sourceName='anticlone_upgrade_'+suffix,targetName='anticlone_restore_'+suffix;
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE DATABASE ${sourceName}`);await root.query(`CREATE DATABASE ${targetName}`);
 const url=(name:string)=>{const u=new URL(process.env.TEST_DATABASE_URL!);u.pathname='/'+name;return u.href;};
 const db=new Pool({connectionString:url(sourceName)});const dir=await mkdtemp(join(tmpdir(),'front3-upgrade-'));
 let previous='',api='',child:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<h1>Original intact</h1><a href="#native">Native</a><script src="${api}/runtime.js"></script><script src="${api}/fallback.js"></script>`)).listen(0,'127.0.0.1');await once(site,'listening');const a=site.address();assert.ok(a&&typeof a!=='string');const original='http://127.0.0.1:'+a.port;
 try{
  await assert.rejects(upgradeLaboratory(root),/isolated upgrade database/);
  assert.equal((await upgradeLaboratory(db,'infra',58)).applied.length,(await readdir('infra')).filter(f=>/^\d{3}_.+\.sql$/.test(f)&&Number(f.slice(0,3))<=58).length);
  await db.query("INSERT INTO projects(id,name,origin) VALUES('upgrade','Synthetic baseline',$1)",[original]);
  await managePages(db,{action:'create',project:'upgrade',name:'Upgrade LP',url:original+'/'});
  const baselineSha='f95e9da0fea5de203bab092fa39a8047bc4404be';
  await assert.rejects(saveOperationalBundle(join(dir,'rejected'),{SMTP_PASSWORD:'synthetic-but-forbidden'},baselineSha),/unsupported keys/);
  const configuration={GATEWAY_MODE:'LAB',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1',SMTP_TLS:'implicit'};
  await saveOperationalBundle(join(dir,'operations'),configuration,baselineSha);
  const recovered=await readOperationalBundle(join(dir,'operations'));assert.deepEqual(recovered.configuration,configuration);assert.equal(recovered.credentialsRequired,true);
  await backup(url(sourceName),join(dir,'database'));
  assert.deepEqual((await upgradeLaboratory(db)).applied,[59,60,61,62,63,64]);assert.deepEqual((await upgradeLaboratory(db)).applied,[]);
  await db.query("UPDATE projects SET name='Upgraded synthetic' WHERE id='upgrade'");
  assert.ok((await db.query("SELECT 1 FROM administrative_change_audit WHERE relation_name='projects' AND operation='UPDATE'")).rowCount);
  const bad=join(dir,'bad');await mkdir(bad);await writeFile(join(bad,'065_atomic_failure.sql'),'CREATE TABLE must_rollback(id int); SELECT missing_upgrade_function();');
  await assert.rejects(upgradeLaboratory(db,bad));assert.equal((await db.query("SELECT to_regclass('must_rollback') missing")).rows[0].missing,null);assert.equal((await db.query('SELECT 1 FROM schema_migration_ledger WHERE version=65')).rowCount,0);
  await copyFile('infra/059_project_registration_audit.sql',join(bad,'059_project_registration_audit.sql'));await writeFile(join(bad,'059_project_registration_audit.sql'),'-- changed checksum\n',{flag:'a'});
  await assert.rejects(upgradeLaboratory(db,bad),/checksum mismatch/);
  await restore(url(targetName),join(dir,'database'),targetName);const restored=new Pool({connectionString:url(targetName)});
  try{assert.equal((await restored.query('SELECT name FROM projects')).rows[0].name,'Synthetic baseline');assert.equal((await restored.query('SELECT max(version)::int v FROM schema_migration_ledger')).rows[0].v,58);assert.deepEqual((await upgradeLaboratory(restored)).applied,[59,60,61,62,63,64]);}finally{await restored.end();}
  // Roll back the executable, retain additive schema/data. No destructive down migration.
  previous=await compilePreviousCode(baselineSha);
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const ra=reserve.address();assert.ok(ra&&typeof ra!=='string');await new Promise<void>(r=>reserve.close(()=>r()));api='http://127.0.0.1:'+ra.port;
  browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
  for(const executable of ['dist/apps/server.js',join(previous,'dist/apps/server.js')]){
   // Require NEW receipts from each executable; retain the incident to prove
   // deduplication across rollback rather than passing on the current process.
   await db.query('DELETE FROM observations; DELETE FROM observation_source_days');
   child=spawn(process.execPath,[executable],{env:{...process.env,...recovered.configuration,DATABASE_URL:url(sourceName),PROJECT_ID:'upgrade',ALLOWED_ORIGIN:original,PORT:String(ra.port)},stdio:'ignore'});
   let ready=false;for(let n=0;n<100;n++){try{if((await fetch(api+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'current/rollback process ready');
   assert.equal((await fetch(api+'/runtime.js')).status,200);
   const page:Page=await browser.newPage();await page.goto(original,{waitUntil:'networkidle'});await page.getByRole('link').click();assert.equal(page.url(),original+'/#native');assert.equal((await db.query("SELECT 1 FROM incidents WHERE host='127.0.0.1'")).rowCount,0);
   await page.goto('http://localhost:'+a.port,{waitUntil:'networkidle'});assert.deepEqual((await db.query("SELECT source FROM observations WHERE host='localhost' ORDER BY source")).rows.map(r=>r.source),['core','fallback']);await page.getByRole('link').click();assert.ok(page.url().endsWith('#native'));await page.close();
   child.kill('SIGTERM');await once(child,'exit');child=undefined;
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM incidents')).rows[0].n,1);
  await writeFile(join(dir,'operations','operational.json'),'{}');await assert.rejects(readOperationalBundle(join(dir,'operations')),/invalid operational bundle/);
  console.log('FRONT3_UPGRADE baseline 001-058 -> 059-064; repeat no-op; failed 065 rollback; checksum refusal; PostgreSQL restore 058 -> 064; current and f95e9da executables PASS');
 }finally{await browser?.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}await new Promise<void>(r=>site.close(()=>r()));await db.end();await root.query(`DROP DATABASE ${sourceName}`);await root.query(`DROP DATABASE ${targetName}`);await root.end();if(previous)await rm(previous,{recursive:true,force:true});await rm(dir,{recursive:true,force:true});}
});
