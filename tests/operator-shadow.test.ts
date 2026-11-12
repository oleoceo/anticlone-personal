import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import {chromium,type Page} from 'playwright';
import {evaluateOperator,proposeStealthV3,type OperatorSignal,recordOperatorShadow,settleOperatorShadow} from '../apps/operator-shadow.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {publishPagePolicy} from '../apps/protection-admin.js';
import {publishCtaPolicy} from '../apps/cta-policy.js';
import {managePages} from '../apps/protected-pages.js';
import {investigation} from '../apps/investigation.js';

const now=1800000000000;
const signal=(kind:OperatorSignal['kind'],source:OperatorSignal['source']='gateway',scope:OperatorSignal['scope']='session'):OperatorSignal=>({kind,source,scope,observedAt:now-1000,validUntil:now+60000,reference:kind});
const positive=signal('session_operator_fixture','controlled_lab');
const cases=[
  {name:'first_direct',operator:false,paid:false,signals:[signal('traffic_claim','browser')]},
  {name:'paid_lead',operator:false,paid:true,signals:[signal('traffic_claim','browser')]},
  {name:'paid_operator',operator:true,paid:true,signals:[positive]},
  {name:'different_device',operator:false,paid:true,signals:[signal('repeated_activity','gateway','group')]},
  {name:'same_network',operator:false,paid:true,signals:[signal('network_overlap')]},
  {name:'simulated_vpn',operator:false,paid:true,signals:[signal('network_overlap','browser')]},
  {name:'missing',operator:true,paid:true,signals:[]},
  {name:'contradictory',operator:true,paid:true,signals:[positive,signal('contradiction')]},
  {name:'expired',operator:true,paid:true,signals:[{...positive,validUntil:now-1}]},
  {name:'approximate_geography',operator:false,paid:true,signals:[signal('coarse_geo','authorized_import')]}
];
function metrics(rows:{operator:boolean;veto:boolean}[]) {
  const tp=rows.filter(r=>r.operator&&r.veto).length,fp=rows.filter(r=>!r.operator&&r.veto).length;
  const fn=rows.filter(r=>r.operator&&!r.veto).length,tn=rows.filter(r=>!r.operator&&!r.veto).length;
  return {tp,fp,fn,tn,falsePositiveRate:fp/(fp+tn),falseNegativeRate:fn/(fn+tp)};
}

type EntryTrace={session?:string;received:number;ready?:number;sent?:number;action?:string;sha256?:string};
const tracePrefix='SHADOW_ENTRY_TRACE ';
// Observe actual server bytes without adding a second HTTP stack to the positive path.
function traceEntry(req:IncomingMessage,res:ServerResponse,rows:EntryTrace[],delay=0){
  if(req.method!=='POST'||!req.url?.endsWith('/entry-decision'))return;
  const trace:EntryTrace={received:performance.now()};rows.push(trace);
  const chunks:Buffer[]=[];req.on('data',(chunk:Buffer)=>chunks.push(chunk));
  req.on('end',()=>{trace.session=(JSON.parse(Buffer.concat(chunks).toString()) as {session:string}).session;});
  const end=res.end;
  res.end=function(this:ServerResponse,chunk?:unknown,...args:unknown[]){
    trace.ready=performance.now();const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));
    if(bytes.length&&chunk!==undefined)trace.action=(JSON.parse(bytes.toString()) as {action:string}).action;trace.sha256=createHash('sha256').update(bytes).digest('hex');
    const send=()=>{trace.sent=performance.now();Reflect.apply(end,this,[chunk,...args]);};
    if(delay)setTimeout(send,delay);else send();return this;
  } as typeof res.end;
}
async function entryProbe(page:Page){
  const events:Record<string,unknown>[]=[];
  page.on('console',message=>{if(message.text().startsWith(tracePrefix))events.push(JSON.parse(message.text().slice(tracePrefix.length)));});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())events.push({event:'navigation',url:frame.url(),nodeMono:performance.now()});});
  await page.addInitScript(prefix=>{
    const emit=(event:string,detail:Record<string,unknown>={})=>console.debug(prefix+JSON.stringify({event,mono:performance.now(),wall:Date.now(),...detail}));
    const timeout=window.setTimeout.bind(window);
    window.setTimeout=((callback:TimerHandler,ms?:number,...args:unknown[])=>{
      // Bootstrap schedules the remaining monotonic budget (e.g. 149.9ms),
      // not necessarily the literal 150. Observe its real timer without
      // changing delay, responses or the existing before/after-deadline asserts.
      const source=document.currentScript instanceof HTMLScriptElement?document.currentScript.src:'';
      if(!source.endsWith('/runtime.js')||typeof ms!=='number'||!Number.isFinite(ms)||ms<0||ms>150||typeof callback!=='function')return timeout(callback,ms,...args);
      emit('deadline-armed',{deadline:performance.now()+ms,scheduledDelay:ms});
      return timeout(()=>{emit('deadline-expired');Reflect.apply(callback,window,args);},ms);
    }) as typeof window.setTimeout;
    const fetch=window.fetch.bind(window);
    window.fetch=(...args)=>{if(String(args[0]).endsWith('/entry-decision'))emit('request');return fetch(...args);};
    const json=Response.prototype.json;
    Response.prototype.json=function(){const url=this.url;return json.call(this).then(decision=>{
      if(url.endsWith('/entry-decision'))emit('parsed',{decision,session:sessionStorage.getItem('anticlone.lab.session')});
      return decision;
    });};
    addEventListener('pagehide',()=>emit('pagehide'));
  },tracePrefix);
  const parsed=page.waitForEvent('console',{predicate:m=>m.text().startsWith(tracePrefix)&&JSON.parse(m.text().slice(tracePrefix.length)).event==='parsed'}).then(m=>JSON.parse(m.text().slice(tracePrefix.length)) as {decision:{action:string};session:string;mono:number});
  return {events,parsed};
}
test('shadow separates group/session, expires evidence and quantifies missed operators',()=>{
  const rows=cases.map(c=>({...c,veto:proposeStealthV3(true,evaluateOperator(c.signals,now,true),now).wouldVeto}));
  assert.deepEqual(rows.filter(r=>r.veto).map(r=>r.name),['paid_operator']);
  assert.deepEqual(metrics(rows),{tp:1,fp:0,fn:3,tn:6,falsePositiveRate:0,falseNegativeRate:0.75});
  for(const c of cases){
    assert.equal(proposeStealthV3(false,evaluateOperator(c.signals,now,true),now).wouldVeto,false);
    assert.equal(evaluateOperator(c.signals,now).v3Proposal.wouldVetoIfEnabled,false);
  }
  assert.equal(proposeStealthV3(true,evaluateOperator([positive],now,true),now+60000).wouldVeto,false);
  assert.equal(evaluateOperator([signal('repeated_activity','gateway','group')],now).group.hypothesis,'ACTIVITY_REQUIRES_INVESTIGATION');
  assert.equal(evaluateOperator([signal('repeated_activity','gateway','group')],now).session.assessment,'INSUFFICIENT');
  assert.equal(evaluateOperator([{...positive,observedAt:now+1000}],now,true).v3Proposal.wouldVetoIfEnabled,false);
  const overflow=evaluateOperator([positive,...Array.from({length:99},()=>signal('activity')),signal('contradiction')],now,true);
  assert.equal(overflow.v3Proposal.wouldVetoIfEnabled,false);assert.ok(overflow.limitations.includes('EVIDENCE_TRUNCATED_ABSTAIN'));
});

test('F13/F14 shadow PostgreSQL/Chromium: ON/OFF collection and unchanged PAGE/CTA decisions',{timeout:90000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='shadow_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,application_name:schema});
  const pageId=randomUUID(),installation=randomUUID();
  let gatewayOrigin='';
  const site=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(req.url?.startsWith('/lp')?
    `<a data-anticlone-surface="main" data-anticlone-point="checkout01" href="/native">Checkout</a><script src="${gatewayOrigin}/i/${installation}/runtime.js"></script>`:'<h1>Destination</h1>')).listen(0,'127.0.0.1');
  await once(site,'listening');const address=site.address();assert.ok(address&&typeof address!=='string');
  const original=`http://127.0.0.1:${address.port}`,copy=`http://localhost:${address.port}`;
  const saved={...process.env};let gateway:ReturnType<typeof createServer>|undefined;
  const transport:EntryTrace[]=[],timing:Record<string,unknown>[]=[];let serverDelay=0;
  const browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
  const evidence:Record<string,unknown>[]=[];
  try {
    for(const file of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+file,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('shadow','Shadow',$1)",[original]);
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'shadow',$2,'LP')",[pageId,installation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,'/lp')",[pageId,original]);
    const point=randomUUID(),dest=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('shadow',$1,'main','checkout01','a','offer')",[point]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES('shadow','offer',$1,$2)",[dest,original+'/cta']);
    await db.query("INSERT INTO cta_mappings VALUES('shadow',$1,'offer',$2)",[point,dest]);
    process.env.SCOPED_LAB_INSTALLATIONS=installation;process.env.SCOPED_LAB_ORIGIN=copy;process.env.SCOPED_LAB_RISK='UNCERTAIN';delete process.env.GATEWAY_MODE;
    const scripts=Object.fromEntries(await Promise.all(['bootstrap','core','fallback'].map(async name=>[name==='bootstrap'?'runtime.js':name+'.js',await readFile('runtime/'+name+'.js')])));
    const handle=scopedGateway(db,scripts,async()=>true);
    gateway=createServer((req,res)=>{traceEntry(req,res,transport,serverDelay);if(!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(gateway,'listening');
    const ga=gateway.address();assert.ok(ga&&typeof ga!=='string');gatewayOrigin=`http://127.0.0.1:${ga.port}`;
    const allocation={PAID_ATTRIBUTED:100,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0};
    for(const stealth of [false,true]) {
      const entry=await publishPagePolicy(db,'shadow',{enabled:true,approved_destination:original+'/page',allocation,stealth,stealth_version:2});
      const cta=await publishCtaPolicy(db,'shadow',{enabled:true,surface:'main',pathname:'/lp',allocation,stealth,stealth_version:2});
      const generation=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[pageId])).rows[0];
      await managePages(db,{action:'approve',project:'shadow',page:pageId,generation:generation.url_generation,configGeneration:generation.config_generation,entryVersion:entry.version,ctaVersions:[cta]});
      const snapshots=(await db.query('SELECT configuration FROM page_policy_approvals')).rows;
      for(const c of cases) {
        const context=await browser.newContext(c.name==='different_device'?{viewport:{width:390,height:844},isMobile:true}:{});
        // All contexts use the same loopback network. Send the forged header
        // through the explicit API probe below, not a CORS-preflight browser bypass.
        if(c.paid)await context.addInitScript(()=>sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify({medium:'cpc'})));
        const page=await context.newPage();
        // This matrix tests shadow/commerce logic, not wall-clock throughput.
        // Freeze browser time during real PostgreSQL/network work; do not intercept HTTP.
        await page.clock.install();await page.clock.pauseAt(new Date());
        const probe=await entryProbe(page);
        timing.push({case:c.name,stealth,clock:'controlled',browser:probe.events});
        await page.goto(copy+'/lp');const {decision,session:runtimeSession}=await probe.parsed;
        assert.equal(decision.action,c.paid?'PAGE_REDIRECT':'OBSERVE_ONLY');
        if(c.paid)await page.waitForURL(original+'/page');else {await page.locator('a').click();await page.waitForURL(copy+'/native');}
        const server=transport.find(t=>t.session===runtimeSession);assert.equal(server?.action,decision.action);
        assert.ok(probe.events.some(e=>e.event==='deadline-armed'),'runtime deadline must be observed');
        Object.assign(timing[timing.length-1],{server,finalUrl:page.url()});
        // Exercise CTA selection independently of the page entry phase.
        const refresh=await context.request.post(`${gatewayOrigin}/i/${installation}/cta-refresh`,{headers:{origin:copy,'content-type':'text/plain',...(c.name==='simulated_vpn'?{'X-Forwarded-For':'192.0.2.44'}:{})},data:JSON.stringify({pathname:'/lp',session:randomUUID().replaceAll('-',''),signals:c.paid?{medium:'cpc'}:{}})});
        assert.equal((await refresh.json() as {action:string}).action,c.paid?'REPLACE_CONVERSION':'OBSERVE_ONLY');
        const assessment=evaluateOperator(c.signals,now,true);
        let operational:ReturnType<typeof evaluateOperator>|undefined;
        for(let attempt=0;attempt<100;attempt++) {
          const date=Number((await db.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS time')).rows[0].time);
          const key=createHash('sha256').update(JSON.stringify(['shadow',pageId,'localhost',Math.floor(date/86400000),runtimeSession])).digest('hex');
          operational=(await db.query('SELECT assessment FROM operator_shadow_assessments WHERE session_context=$1',[key])).rows[0]?.assessment;
          if(operational)break;await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.ok(operational,'real runtime session must have a persisted shadow assessment');
        evidence.push({name:c.name,stealth,operator:c.operator,commercial:decision.action,operational,syntheticProposal:proposeStealthV3(stealth,assessment,now),syntheticAssessment:assessment});
        await context.close();
      }
      assert.deepEqual((await db.query('SELECT configuration FROM page_policy_approvals')).rows,snapshots);
    }
    // Flush complementary history and prove dedup, scoped separation and retention.
    await settleOperatorShadow(db);
    await recordOperatorShadow(db,'shadow',pageId,'localhost','a'.repeat(32),'PAID_ATTRIBUTED',Date.now());
    await recordOperatorShadow(db,'shadow',pageId,'localhost','a'.repeat(32),'PAID_ATTRIBUTED',Date.now());
    const recorded=await db.query('SELECT * FROM operator_shadow_assessments');assert.equal(recorded.rowCount,41);
    assert.ok(recorded.rows.every(r=>r.assessment.commercialDecisionChanged===false&&!r.assessment.v3Proposal.wouldVetoIfEnabled));
    assert.ok(recorded.rows.every(r=>r.session_context!=='a'.repeat(32)));
    const profile=(await investigation(db,'shadow')).find(r=>r.host==='localhost');assert.ok(profile);
    assert.equal(profile.operator_profile.sessions.available,true);assert.ok(profile.operator_profile.sessions.events.length);
    const snapshot=JSON.stringify((await db.query('SELECT assessment FROM operator_shadow_assessments ORDER BY id LIMIT 1')).rows);
    await recordOperatorShadow(db,'shadow',pageId,'localhost','a'.repeat(32),'DIRECT_UNKNOWN',Date.now());
    assert.equal(JSON.stringify((await db.query('SELECT assessment FROM operator_shadow_assessments ORDER BY id LIMIT 1')).rows),snapshot,'new observations do not rewrite snapshots');
    await db.query('ALTER TABLE operator_shadow_assessments RENAME TO unavailable_shadow');
    const degraded=await fetch(`${gatewayOrigin}/i/${installation}/entry-decision`,{method:'POST',headers:{origin:copy,'content-type':'text/plain'},body:JSON.stringify({pathname:'/lp',session:'e'.repeat(32),signals:{medium:'cpc'}})});
    assert.equal((await degraded.json() as {action:string}).action,'PAGE_REDIRECT');
    await settleOperatorShadow(db);
    await db.query('ALTER TABLE unavailable_shadow RENAME TO operator_shadow_assessments');
    const operation=metrics(evidence.filter(r=>r.stealth===true).map(r=>({operator:r.operator as boolean,veto:(r.operational as ReturnType<typeof evaluateOperator>).v3Proposal.wouldVetoIfEnabled})));
    assert.deepEqual(operation,{tp:0,fp:0,fn:4,tn:6,falsePositiveRate:0,falseNegativeRate:1});
    await db.query("UPDATE operator_shadow_assessments SET recorded_at=clock_timestamp()-interval '8 days'");
    await recordOperatorShadow(db,'shadow',pageId,'localhost','b'.repeat(32),'DIRECT_UNKNOWN',Date.now());
    assert.equal((await db.query('SELECT count(*)::int n FROM operator_shadow_assessments')).rows[0].n,1);
    const delayedAt=Date.now()-600000;
    await recordOperatorShadow(db,'shadow',pageId,'localhost','c'.repeat(32),'DIRECT_UNKNOWN',delayedAt);
    const delayed=(await db.query('SELECT assessment FROM operator_shadow_assessments ORDER BY id DESC LIMIT 1')).rows[0].assessment as ReturnType<typeof evaluateOperator>;
    assert.equal(delayed.sources[0].observedAt,delayedAt);assert.ok(delayed.limitations.includes('EXPIRED_OR_INVALID_EVIDENCE'));
    // Existing admin imports lock the page before the project advisory lock.
    // A complementary writer must not hold that advisory while waiting on the page.
    const admin=await db.connect();let pending:Promise<void>|undefined;
    try {
      await admin.query('BEGIN');await admin.query("SET LOCAL lock_timeout='500ms'");
      await admin.query('SELECT id FROM protected_pages WHERE id=$1 FOR UPDATE',[pageId]);
      pending=recordOperatorShadow(db,'shadow',pageId,'localhost','d'.repeat(32),'DIRECT_UNKNOWN',Date.now());
      let blocked=false;
      for(let attempt=0;attempt<100;attempt++) {
        blocked=!!(await root.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM protected_pages%'",[schema])).rowCount;
        if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.ok(blocked,'shadow must be waiting on the held page lock');
      await admin.query('SELECT pg_advisory_xact_lock(hashtext($1))',['shadow']);
    } finally {await admin.query('ROLLBACK');admin.release();await pending;}
    // Real-clock negatives: same genuine PAGE_REDIRECT, delivered after 150 ms.
    // The route case reproduces the former harness; only latency is injected.
    for(const mode of ['direct-realtime','server-delay','route-delay'] as const){
      const context=await browser.newContext();await context.addInitScript(()=>sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify({medium:'cpc'})));
      const page=await context.newPage(),probe=await entryProbe(page);let forwardedHash:string|undefined,routeReady:number|undefined,routeSent:number|undefined;
      const row:Record<string,unknown>={case:mode,clock:'real',browser:probe.events};timing.push(row);
      serverDelay=mode==='server-delay'?250:0;
      if(mode==='direct-realtime'){
        await page.goto(copy+'/lp');const result=await probe.parsed;Object.assign(row,{server:transport.find(t=>t.session===result.session),finalUrl:page.url()});assert.equal(result.decision.action,'PAGE_REDIRECT');
        const armed=probe.events.find(e=>e.event==='deadline-armed');assert.ok(armed);assert.ok(result.mono<Number(armed.deadline),'direct decision must arrive within the 150 ms browser budget');
        await page.waitForURL(original+'/page');row.finalUrl=page.url();await context.close();continue;
      }
      if(mode==='route-delay')await context.route('**/entry-decision',async route=>{
        const upstream=await route.fetch({maxRedirects:0}),body=await upstream.body();routeReady=performance.now();
        forwardedHash=createHash('sha256').update(body).digest('hex');await new Promise(r=>setTimeout(r,250));
        routeSent=performance.now();Object.assign(row,{routeReady,routeSent});await route.fulfill({response:upstream,body});
      });
      const refreshed=page.waitForResponse(r=>r.url().endsWith('/cta-refresh'));
      await page.goto(copy+'/lp');const result=await probe.parsed,server=transport.find(t=>t.session===result.session);Object.assign(row,{server,finalUrl:page.url()});
      assert.equal((await (await refreshed).json()).action,'REPLACE_CONVERSION');await page.waitForTimeout(100);
      assert.equal(server?.action,'PAGE_REDIRECT');assert.equal(result.decision.action,'PAGE_REDIRECT');
      const armed=probe.events.find(e=>e.event==='deadline-armed');assert.ok(armed);assert.ok(result.mono>=Number(armed.deadline));
      assert.ok(probe.events.some(e=>e.event==='deadline-expired'));
      // Timers need not fire at an exact fractional millisecond; prove the hold
      // exceeded the unchanged commercial budget as well as observing expiry.
      if(mode==='route-delay'){assert.equal(forwardedHash,server.sha256);assert.ok(routeSent!-routeReady!>150);}
      else assert.ok(server.sent!-server.ready!>150);
      assert.equal(page.url(),copy+'/lp','late PAGE must never navigate');
      // Late page entry must not veto the independently refreshed approved CTA.
      await page.locator('a').click();await page.waitForURL(original+'/cta');
      row.ctaFinalUrl=page.url();
      await context.close();serverDelay=0;
    }
    const originalContext=await browser.newContext(),originalPage=await originalContext.newPage(),originalProbe=await entryProbe(originalPage);
    await originalPage.goto(original+'/lp');assert.equal((await originalProbe.parsed).decision.action,'OBSERVE_ONLY');
    await originalPage.locator('a').click();await originalPage.waitForURL(original+'/native');timing.push({case:'original',clock:'real',browser:originalProbe.events,finalUrl:originalPage.url()});await originalContext.close();
    await mkdir('test-results/operator-shadow',{recursive:true});await writeFile('test-results/operator-shadow/calibration.json',JSON.stringify({dataset:'synthetic-controlled-v1',notFieldCalibration:true,browser:browser.version(),operation,synthetic:metrics(cases.map(c=>({operator:c.operator,veto:proposeStealthV3(true,evaluateOperator(c.signals,now,true),now).wouldVeto}))),evidence,timing},null,2));
  } finally {
    await mkdir('test-results/operator-shadow',{recursive:true});await writeFile('test-results/operator-shadow/entry-timing.json',JSON.stringify({transport,timing},null,2));
    const summary=timing.map(row=>{const events=row.browser as Record<string,unknown>[],server=row.server as EntryTrace|undefined;
      return {case:row.case,stealth:row.stealth,clock:row.clock,backendMs:server?.ready===undefined?null:server.ready-server.received,
        serverHoldMs:server?.sent===undefined?null:server.sent-server.ready!,routeHoldMs:row.routeSent===undefined?null:Number(row.routeSent)-Number(row.routeReady),
        parsedMs:events.find(e=>e.event==='parsed')?.mono,deadlineMs:events.find(e=>e.event==='deadline-armed')?.deadline,
        expired:events.some(e=>e.event==='deadline-expired'),action:(events.find(e=>e.event==='parsed')?.decision as {action:string}|undefined)?.action,
        finalUrl:row.finalUrl,ctaFinalUrl:row.ctaFinalUrl};});
    process.stdout.write('SHADOW_ENTRY_TIMING '+JSON.stringify(summary)+'\n');
    process.env=saved;await browser.close();if(gateway)await new Promise<void>(resolve=>gateway!.close(()=>resolve()));await new Promise<void>(resolve=>site.close(()=>resolve()));await settleOperatorShadow(db);await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
  }
});
