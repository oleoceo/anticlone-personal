import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {performance} from 'node:perf_hooks';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {importOriginalRequest,receiptHistory,retainInvestigationReceipts,receiveRuntimeReceipt} from '../apps/investigation-receipts.js';
import {investigation} from '../apps/investigation.js';
import {distributionAdmin} from '../apps/runtime-distribution.js';
import {distributionGateway} from '../apps/distribution-gateway.js';

async function laboratory(run:(db:Pool,page:string,installation:string)=>Promise<void>) {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='receiptvolume_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:10});
  const page=randomUUID(),installation=randomUUID();
  try{
    for(const file of (await readdir('infra')).filter(file=>/^\d{3}_.+\.sql$/.test(file)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects VALUES('one','One','https://original.test'),('two','Two','https://other.test')");
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'one',$2,'LP')",[page,installation]);
    await run(db,page,installation);
  }finally{await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
}

test('authorized log time: strict UTC, independent import time, conflicts, unknown and retention',async()=>laboratory(async(db,page)=>{
  const accessed=new Date(Date.now()-2*86400_000).toISOString();
  const body={id:randomUUID(),page,resource:'HTML',source:'owned_access_log',authorized:true,accessed_at:accessed};
  const saved=await importOriginalRequest(db,'one',body);
  assert.equal(saved.accessed_at,accessed);assert.ok(new Date(saved.imported_at).getTime()>Date.parse(accessed));
  const again=await importOriginalRequest(db,'one',body);assert.equal(again.state,'ALREADY_IMPORTED');assert.deepEqual(again.imported_at,saved.imported_at);
  await assert.rejects(importOriginalRequest(db,'one',{...body,accessed_at:new Date(Date.parse(accessed)+1).toISOString()}),TypeError);
  await assert.rejects(importOriginalRequest(db,'one',{...body,accessed_at:null}),TypeError);
  for(const bad of ['2026-02-30T12:00:00.000Z','2026-01-01',123,'2026-11-10T12:00:00+00:00','2026-11-10T12:00:00Z',new Date(Date.now()+3600_000).toISOString(),new Date(Date.now()-8*86400_000).toISOString()])await assert.rejects(importOriginalRequest(db,'one',{...body,id:randomUUID(),accessed_at:bad}),TypeError);
  const unknown=await importOriginalRequest(db,'one',{...body,id:randomUUID(),accessed_at:null});assert.equal(unknown.accessed_at,'UNKNOWN');
  const history=await receiptHistory(db,'one',{});assert.equal(history.events.length,2);
  assert.equal(history.events[0].accessed_at_provenance,'AUTHORIZED_LOG_DECLARATION_NOT_INDEPENDENTLY_VERIFIED');
  assert.equal(history.events[1].accessed_at,'UNKNOWN');
  await db.query("INSERT INTO incidents(project_id,host) VALUES('one','copy.test')");
  await db.query("INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,claimed_host) SELECT 'one',id,installation_id,'runtime_receipt','core','observe','copy.test' FROM protected_pages WHERE id=$1",[page]);
  const row=(await investigation(db,'one'))[0];
  assert.ok(row.history.chronology.some((event:{at:string;state:string})=>event.at===accessed&&event.state==='Declarado pela fonte'));
  assert.equal(row.contextual_assessment.level,'UNCERTAIN');
  await db.query("UPDATE investigation_receipts SET accessed_at=clock_timestamp()-interval '8 days' WHERE import_id=$1",[body.id]);
  assert.equal((await receiptHistory(db,'one',{})).events.some(event=>event.id===history.events[0].id),false);
  await retainInvestigationReceipts(db,'two');assert.equal((await db.query('SELECT 1 FROM investigation_receipts WHERE import_id=$1',[body.id])).rowCount,1);
  await retainInvestigationReceipts(db,'one');assert.equal((await db.query('SELECT 1 FROM investigation_receipts WHERE import_id=$1',[body.id])).rowCount,0);
  // Existing 054 without the optional extension remains usable, without inventing time.
  await db.query('ALTER TABLE investigation_receipts DROP COLUMN accessed_at');
  await assert.rejects(importOriginalRequest(db,'one',{...body,id:randomUUID()}),TypeError);
  await importOriginalRequest(db,'one',{...body,id:randomUUID(),accessed_at:null});
  assert.ok((await receiptHistory(db,'one',{})).events.every(event=>event.accessed_at==='UNKNOWN'));
}));

test('near capacity: bounded investigation, complete keyset history and concurrent passive persistence',{timeout:90000},async()=>laboratory(async(db,page,installation)=>{
  await db.query("INSERT INTO incidents(project_id,host) SELECT 'one','copy'||n||'.test' FROM generate_series(1,100) n");
  await db.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,import_id,accessed_at)
    SELECT 'one',$1,$2,'original_request','owned_access_log','HTML',gen_random_uuid(),clock_timestamp()-interval '1 day' FROM generate_series(1,9800)`,[page,installation]);
  await db.query("UPDATE investigation_receipts SET accessed_at=clock_timestamp()-interval '3 days' WHERE id=5000");
  await db.query(`INSERT INTO investigation_receipts(project_id,page_id,installation_id,kind,source,resource,claimed_host)
    SELECT 'one',$1,$2,'runtime_receipt','core','observe','copy'||n||'.test' FROM generate_series(1,100) n`,[page,installation]);
  const before=process.memoryUsage();let peakHeap=before.heapUsed,peakRss=before.rss;
  const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
  const timer=setInterval(sample,5);const started=performance.now();
  const rows=await investigation(db,'one');const queryMs=performance.now()-started;
  const encoded=JSON.stringify(rows);sample();clearInterval(timer);
  const bytes=Buffer.byteLength(encoded);
  assert.equal(rows.length,100);assert.ok(bytes<3_000_000,'bounded administrative response');
  for(const row of rows){assert.equal(row.linked_evidence.total,9801);assert.equal(row.linked_evidence.events.length,4);assert.equal(row.linked_evidence.omitted,9797);assert.ok(row.linked_evidence.events.some((event:{id:string})=>event.id==='5000'),'earliest declared access is preserved even when imported in the middle');assert.ok(row.contextual_assessment.sources.length<=5);assert.equal(row.contextual_assessment.level,'UNCERTAIN');}
  const seen=new Set<string>();let after:string|null=null;let pages=0;
  do{const chunk=await receiptHistory(db,'one',after?{after}:{});assert.ok(chunk.events.length<=100);for(const event of chunk.events){assert.equal(seen.has(event.id),false);seen.add(event.id);}after=chunk.next_after;pages++;}while(after);
  assert.equal(seen.size,9900);assert.equal(pages,99);
  assert.equal((await receiptHistory(db,'two',{})).events.length,0);
  assert.equal((await receiptHistory(db,'one',{page:randomUUID()})).events.length,0);
  for(const cursor of [{after:'-1'},{after:'9223372036854775808'},{after:1},{page:'bad'},{host:'copy1.test'}])await assert.rejects(receiptHistory(db,'one',cursor),TypeError);
  const context={project:'one',page,installation,urls:[]};
  const gateway=createServer();
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const base='http://127.0.0.1:'+(gateway.address() as AddressInfo).port;
  const publication=await distributionAdmin(db,{project:'one',page,action:'publish'},{RUNTIME_PUBLIC_ORIGIN:base});assert.ok(publication.distribution);
  const distributed=distributionGateway(db,{'runtime.js':Buffer.from('const distribution = null;')},(_req,res)=>res.writeHead(404).end());
  gateway.on('request',(req,res)=>{if(!distributed(req,res))res.writeHead(404).end();});
  const blocker=await db.connect();const tasks:(Promise<void>|undefined)[]=[];
  let scriptMs=0,persistenceMs=0;
  try{
    await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('one'))");
    const persistStart=performance.now();
    for(let n=0;n<100;n++)tasks.push(receiveRuntimeReceipt(db,context,'observe','core',n<25?'copy1.test':'new'+n+'.test'));
    const scriptStart=performance.now();
    const response=await fetch(publication.distribution.bases.SCRIPT+(publication.distribution.paths?.['runtime.js']??'runtime.js'),{signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200);scriptMs=performance.now()-scriptStart;
    assert.ok(db.totalCount<=10);assert.ok(db.waitingCount<=1,'passive queue does not fill the connection pool');
    await blocker.query('ROLLBACK');await Promise.all(tasks);persistenceMs=performance.now()-persistStart;
    const count=Number((await db.query("SELECT count(*) n FROM investigation_receipts WHERE project_id='one'")).rows[0].n);assert.ok(count>=9975&&count<=10000);
    console.log('INVESTIGATION_VOLUME '+JSON.stringify({receipts_before:9900,incidents:100,response_bytes:bytes,query_ms:Math.round(queryMs),sampled_heap_increase_bytes:Math.max(0,peakHeap-before.heapUsed),sampled_rss_increase_bytes:Math.max(0,peakRss-before.rss),concurrent_calls:100,persistence_ms:Math.round(persistenceMs),script_while_locked_ms:Math.round(scriptMs),receipts_after:count,pool_max:10,active_complementary_limit:1}));
  }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.all(tasks);gateway.close();}
}));
