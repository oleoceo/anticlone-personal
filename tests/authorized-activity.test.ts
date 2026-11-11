import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {readFile,readdir,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {ingestActivity,signActivity,issueActivitySession,correlateActivity,sessionContext,type Activity,type ActivitySource} from '../apps/authorized-activity.js';
import {importActivityFile} from '../apps/activity-import.js';
import {scopedGateway} from '../apps/scoped-gateway.js';
import {settleOperatorShadow,proposeStealthV3,evaluateOperator} from '../apps/operator-shadow.js';
import {publishPagePolicy} from '../apps/protection-admin.js';
import {publishCtaPolicy} from '../apps/cta-policy.js';
import {managePages} from '../apps/protected-pages.js';

test('authorized original activity: real ingestion, browser copy, correlation and commercial invariance',{timeout:120000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='activity_'+randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const pageId=randomUUID(),installation=randomUUID();
  const source:ActivitySource={id:'owned-server',project:'activity',page:pageId,key:randomBytes(32).toString('hex'),sessionContinuity:true};
  const directory=await mkdtemp(join(tmpdir(),'activity-'));
  const config=join(directory,'sources.json'),file=join(directory,'event.json');
  await writeFile(config,JSON.stringify([source]));
  let gatewayOrigin='',checkoutRevision=0;
  const template='<link rel="stylesheet" href="/style"><a href="/native" data-anticlone-surface="main" data-anticlone-point="checkout01">Checkout</a><script src="GATEWAY/i/INSTALLATION/runtime.js"></script>';
  let copiedHtml=template;const signed:Activity[]=[];
  const deferredActors=new Set<string>(),deferred:Activity[]=[];
  const persist=async(event:Activity)=>{await writeFile(file,JSON.stringify({event,signature:signActivity(event,source.key)}));return importActivityFile(db,file,config);};
  const emit=async(event:Activity)=>{signed.push(event);if(deferredActors.has(event.actor)&&event.kind==='RESOURCE_REQUEST'){deferred.push(event);return {state:'QUEUED'};}return persist(event);};
  // Only this private test server knows account capabilities. An arbitrary public
  // resource request cannot assert authenticated account/session continuity.
  const accounts=new Map<string,string>(),pendingBindings=new Map<string,Activity>();
  const originalServer=createServer((req,res)=>{
    if(req.url==='/unavailable'){res.writeHead(503).end('Source unavailable');return;}
    if(['/page','/cta'].includes(req.url??'')){res.writeHead(200).end('Approved destination');return;}
    const actor=accounts.get(req.headers.authorization??'');
    if(!actor){res.writeHead(401).end();return;}
    let body='';req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{void(async()=>{
      const base={version:1 as const,id:randomUUID(),project:'activity',page:pageId,source:source.id,actor,observedAt:Date.now(),country:'BR',network:'RESIDENTIAL' as const};
      if(req.url==='/test'&&req.method==='POST') {
        if(Object.keys(JSON.parse(body)).length){res.writeHead(400).end();return;}
        const event={...base,kind:'ISSUED_TEST_CONTEXT' as const,host:'localhost',country:'BR',network:'UNKNOWN' as const};
        const session=issueActivitySession(event,source.key);
        // Issuance is server-side. Never sign a client-selected lead session.
        pendingBindings.set(session,{...event,session});
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({session}));return;
      }else if(req.url==='/checkout'&&req.method==='POST'){
        copiedHtml=copiedHtml.replace(/href="\/native[^\"]*"/,`href="/native?revision=${++checkoutRevision}"`);
        await emit({...base,kind:'CHECKOUT_CHANGED'});
      }
      else {
        const resource=({'/export':'HTML','/script':'SCRIPT','/style':'STYLE'} as const)[req.url as '/export'];
        if(!resource){res.writeHead(404).end();return;}
        await emit({...base,kind:'RESOURCE_REQUEST',resource});
      }
      res.writeHead(200).end(req.url==='/export'?template:req.url==='/script'?'/* owned export script */':req.url==='/style'?'a{color:blue}':'authorized operation received');
    })().catch(()=>res.writeHead(503).end());});
  }).listen(0,'127.0.0.1');await once(originalServer,'listening');
  const oa=originalServer.address();assert.ok(oa&&typeof oa!=='string');const original=`http://127.0.0.1:${oa.port}`;
  const copyServer=createServer((req,res)=>res.writeHead(200,{'content-type':req.url==='/style'?'text/css':'text/html'}).end(req.url==='/style'?'a{color:blue}':copiedHtml.replace('GATEWAY',gatewayOrigin).replace('INSTALLATION',installation))).listen(0,'127.0.0.1');
  await once(copyServer,'listening');const ca=copyServer.address();assert.ok(ca&&typeof ca!=='string');const copy=`http://localhost:${ca.port}`;
  const saved={...process.env};let gateway:ReturnType<typeof createServer>|undefined;
  const browser=await chromium.launch({args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
  const rows:Record<string,unknown>[]=[];const timings={before:[] as number[],after:[] as number[],cta:[] as number[]};
  const observedNetworks=new Set<string>();
  try {
    for(const name of (await readdir('infra')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.query((await readFile('infra/'+name,'utf8')).replace(/^\uFEFF/,''));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('activity','Activity',$1)",[original]);
    await db.query("INSERT INTO protected_pages(id,project_id,installation_id,name) VALUES($1,'activity',$2,'LP')",[pageId,installation]);
    await db.query("INSERT INTO protected_page_urls(page_id,origin,pathname) VALUES($1,$2,'/lp')",[pageId,original]);
    const point=randomUUID(),dest=randomUUID();
    await db.query("INSERT INTO cta_points(project_id,id,surface,marker,kind,offer) VALUES('activity',$1,'main','checkout01','a','offer')",[point]);
    await db.query("INSERT INTO cta_destinations(project_id,offer,id,url) VALUES('activity','offer',$1,$2)",[dest,original+'/cta']);
    await db.query("INSERT INTO cta_mappings VALUES('activity',$1,'offer',$2)",[point,dest]);
    process.env.SCOPED_LAB_INSTALLATIONS=installation;process.env.SCOPED_LAB_ORIGIN=copy;process.env.SCOPED_LAB_RISK='UNCERTAIN';delete process.env.GATEWAY_MODE;
    const scripts=Object.fromEntries(await Promise.all(['bootstrap','core','fallback'].map(async n=>[n==='bootstrap'?'runtime.js':n+'.js',await readFile('runtime/'+n+'.js')])));
    const handle=scopedGateway(db,scripts,async()=>true);gateway=createServer((req,res)=>{observedNetworks.add(req.socket.remoteAddress!);if(!handle(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(gateway,'listening');
    const ga=gateway.address();assert.ok(ga&&typeof ga!=='string');gatewayOrigin=`http://127.0.0.1:${ga.port}`;
    const cases=[
      {name:'paid_operator',operator:true,bound:true,paid:true},
      {name:'mobile_operator_changed_network',operator:true,bound:true,paid:true},
      {name:'operator_without_continuity',operator:true,bound:false,paid:true},
      {name:'operator_contradiction',operator:true,bound:true,paid:true,contradiction:true},
      {name:'paid_lead_shared_network',operator:false,bound:false,paid:true},
      {name:'same_country_no_utm',operator:false,bound:false,paid:false},
      {name:'lead_multiple_devices',operator:false,bound:false,paid:true},
      {name:'first_direct_visit',operator:false,bound:false,paid:false},
      {name:'checkout_without_resource_sequence',operator:false,bound:true,paid:true,noResources:true},
      {name:'source_unavailable',operator:false,bound:false,paid:true}
    ];
    for(const stealth of [false,true]) {
      const allocation={PAID_ATTRIBUTED:100,ORGANIC:0,REFERRAL:0,DIRECT_UNKNOWN:0};
      const entry=await publishPagePolicy(db,'activity',{enabled:true,approved_destination:original+'/page',allocation,stealth,stealth_version:2});
      const cta=await publishCtaPolicy(db,'activity',{enabled:true,surface:'main',pathname:'/lp',allocation,stealth,stealth_version:2});
      const g=(await db.query('SELECT url_generation,config_generation FROM protected_pages WHERE id=$1',[pageId])).rows[0];
      await managePages(db,{action:'approve',project:'activity',page:pageId,generation:g.url_generation,configGeneration:g.config_generation,entryVersion:entry.version,ctaVersions:[cta]});
      const approvals=JSON.stringify((await db.query('SELECT configuration FROM page_policy_approvals ORDER BY id')).rows);
      for(const c of cases) {
        const context=await browser.newContext(c.name.startsWith('mobile')?{isMobile:true,viewport:{width:390,height:844}}:{});
        const actor=createHash('sha256').update(randomUUID()).digest('hex'),account=randomBytes(24).toString('hex');accounts.set(account,actor);
        if(c.name.startsWith('mobile'))deferredActors.add(actor);
        const request=async(path:string,body?:unknown)=>{const response=await fetch(original+path,{method:body?'POST':'GET',headers:{authorization:account},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200);const content=await response.text();if(path==='/export')copiedHtml=content;return content;};
        if(c.operator&&!c.noResources)for(const path of ['/export','/script','/style'])await request(path);
        if(c.name==='same_country_no_utm')await request('/export');
        if(c.operator||c.bound){await new Promise(r=>setTimeout(r,2));await request('/checkout',{});}
        let issued:string|undefined;
        if(c.bound){await new Promise(r=>setTimeout(r,2));issued=(JSON.parse(await request('/test',{})) as {session:string}).session;}
        const page=await context.newPage();
        if(issued)await context.addInitScript(value=>sessionStorage.setItem('anticlone.lab.session',value),issued);
        if(c.paid)await context.addInitScript(()=>sessionStorage.setItem('anticlone.lab.attribution',JSON.stringify({medium:'cpc'})));
        const captured=new Promise<string>(resolve=>page.on('request',req=>{if(req.url().endsWith('/entry-decision'))resolve((JSON.parse(req.postData()!) as {session:string}).session);}));
        await page.goto(copy+'/lp');const session=await captured;
        await settleOperatorShadow(db);
        const key=sessionContext('activity',pageId,'localhost',session,Date.now());
        const initial=await correlateActivity(db,'activity',pageId,key,Date.now());assert.equal(initial.wouldVetoIfApproved,false);
        const call=async(phase:'before'|'after'|'cta',endpoint='entry-decision')=>{
          const started=performance.now();const response=await context.request.post(`${gatewayOrigin}/i/${installation}/${endpoint}`,{headers:{origin:copy,'content-type':'text/plain'},data:JSON.stringify({pathname:'/lp',session,signals:c.paid?{medium:'cpc'}:{}})});
          const result=await response.json() as {action:string};timings[phase].push(performance.now()-started);
          assert.equal(result.action,c.paid?(endpoint==='entry-decision'?'PAGE_REDIRECT':'REPLACE_CONVERSION'):'OBSERVE_ONLY');return result;
        };
        await call('before');
        if(c.bound){assert.equal(session,issued);await emit(pendingBindings.get(session)!);}
        if(deferredActors.has(actor)) {
          assert.equal((await correlateActivity(db,'activity',pageId,key,Date.now())).wouldVetoIfApproved,false,'incomplete delayed resources must abstain');
          for(const event of deferred.filter(e=>e.actor===actor))await persist(event);
        }
        if(c.contradiction)await emit({version:1,id:randomUUID(),project:'activity',page:pageId,source:source.id,actor,observedAt:Date.now(),kind:'CONTRADICTION'});
        if(c.name.startsWith('mobile')) {
          // Same issued context, genuinely different loopback source address.
          const changed=await new Promise<string>((resolve,reject)=>{const req=httpRequest(`${gatewayOrigin}/i/${installation}/entry-decision`,{method:'POST',localAddress:'127.0.0.2',headers:{origin:copy,'content-type':'text/plain'}},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve(body));});req.on('error',reject);req.end(JSON.stringify({pathname:'/lp',session,signals:{medium:'cpc'}}));});
          assert.equal(JSON.parse(changed).action,'PAGE_REDIRECT');assert.ok(observedNetworks.has('127.0.0.2'));
        }
        if(c.name==='source_unavailable') {
          assert.equal((await fetch(original+'/unavailable',{headers:{authorization:account}})).status,503);
          assert.equal((await fetch(original+'/test',{method:'POST',headers:{authorization:'unavailable-source'},body:'{}'})).status,401);
        }
        await call('after');await call('cta','cta-refresh');await settleOperatorShadow(db);
        const assessment=await correlateActivity(db,'activity',pageId,key,Date.now());
        const snapshots=(await db.query('SELECT assessment FROM operator_shadow_assessments WHERE session_context=$1 ORDER BY id',[key])).rows;
        const latest=snapshots.at(-1)!.assessment;
        assert.equal(assessment.wouldVetoIfApproved,c.bound&&c.operator&&!c.contradiction);
        assert.equal(latest.v3Proposal.wouldVetoIfEnabled,assessment.wouldVetoIfApproved);
        assert.equal(latest.v3Proposal.operationallyEligible,false);assert.equal(latest.commercialDecisionChanged,false);
        assert.equal(proposeStealthV3(false,latest,Date.now()).wouldVeto,false);
        assert.equal(proposeStealthV3(true,latest,Date.now()).operationalVeto,false);
        assert.equal(latest.session.probability,null);
        if(assessment.wouldVetoIfApproved){assert.ok(snapshots.length>=2);assert.equal(snapshots[0].assessment.v3Proposal.wouldVetoIfEnabled,false);}
        rows.push({name:c.name,stealth,operator:c.operator,predicted:assessment.wouldVetoIfApproved,assessment});await context.close();
      }
      assert.equal(JSON.stringify((await db.query('SELECT configuration FROM page_policy_approvals ORDER BY id')).rows),approvals);
    }
    const first=signed[0];assert.equal((await ingestActivity(db,first,signActivity(first,source.key),source)).state,'DUPLICATE');
    const yesterday={...first,id:randomUUID(),observedAt:first.observedAt-86400000};await persist(yesterday);
    const contexts=(await db.query('SELECT actor_context FROM authorized_activity WHERE event_id=ANY($1::uuid[])',[[first.id,yesterday.id]])).rows;
    assert.equal(new Set(contexts.map(r=>r.actor_context)).size,2,'daily rotation is enforced even if source reuses actor');
    await assert.rejects(ingestActivity(db,{...first,resource:'IMAGE'},signActivity(first,source.key),source),/signature/);
    const changed={...first,resource:'IMAGE' as const};await assert.rejects(ingestActivity(db,changed,signActivity(changed,source.key),source),/conflicting replay/);
    const hostile={...first,ip:'192.0.2.1'};await assert.rejects(ingestActivity(db,hostile,signActivity(hostile,source.key),source),/invalid activity/);
    await assert.rejects(ingestActivity(db,first,signActivity(first,source.key),{...source,project:'elsewhere'}),/invalid activity/);
    const continuity=signed.find(e=>e.kind==='ISSUED_TEST_CONTEXT')!;
    await assert.rejects(ingestActivity(db,continuity,signActivity(continuity,source.key),{...source,sessionContinuity:false}),/continuity/);
    const key=sessionContext('activity',pageId,'localhost',continuity.session!,continuity.observedAt);
    let baselineLatency:unknown=null;
    if(process.env.ACTIVITY_BASELINE_MODULE) {
      const baseline=await import(pathToFileURL(process.env.ACTIVITY_BASELINE_MODULE).href) as typeof import('../apps/scoped-gateway.js');
      const old=baseline.scopedGateway(db,scripts,async()=>true);
      const server=createServer((req,res)=>{if(!old(req,res))res.writeHead(404).end();}).listen(0,'127.0.0.1');await once(server,'listening');
      try {
        const ba=server.address();assert.ok(ba&&typeof ba!=='string');const url=`http://127.0.0.1:${ba.port}`;
        const results:Record<string,number[]>={};
        for(const endpoint of ['entry-decision','cta-refresh'])for(let i=0;i<35;i++)for(const [version,origin] of i%2?[['new',gatewayOrigin],['baseline',url]]:[['baseline',url],['new',gatewayOrigin]]) {
          const started=performance.now();const response=await fetch(`${origin}/i/${installation}/${endpoint}`,{method:'POST',headers:{origin:copy,'content-type':'text/plain'},body:JSON.stringify({pathname:'/lp',session:continuity.session,signals:{medium:'cpc'}})});
          const body=await response.json() as {action:string};assert.equal(body.action,endpoint==='entry-decision'?'PAGE_REDIRECT':'REPLACE_CONVERSION');
          if(i>=5)(results[version+'_'+endpoint]??=[]).push(performance.now()-started);
        }
        baselineLatency=Object.fromEntries(Object.entries(results).map(([name,samples])=>{samples.sort((a,b)=>a-b);return [name,{n:samples.length,p50:samples[15],p95:samples[28],max:samples.at(-1)}];}));
      }finally{await new Promise<void>(r=>server.close(()=>r()));}
    }
    assert.equal((await correlateActivity(db,'activity',pageId,key,Date.now()+300001)).wouldVetoIfApproved,false);
    const delayed={...continuity,id:randomUUID(),observedAt:Date.now()-600000,session:''};delayed.session=issueActivitySession(delayed,source.key);await emit(delayed);
    assert.equal((await correlateActivity(db,'activity',pageId,sessionContext('activity',pageId,'localhost',delayed.session,delayed.observedAt),Date.now())).wouldVetoIfApproved,false);
    const stolen={...continuity,id:randomUUID()};await assert.rejects(ingestActivity(db,stolen,signActivity(stolen,source.key),source),/invalid issued context/);
    const gap={...first,id:randomUUID(),actor:createHash('sha256').update('different-account').digest('hex'),kind:'SOURCE_GAP' as const,resource:undefined,observedAt:Date.now()};await emit(gap);
    const other=signed.filter(e=>e.kind==='ISSUED_TEST_CONTEXT')[1];assert.equal((await correlateActivity(db,'activity',pageId,sessionContext('activity',pageId,'localhost',other.session!,other.observedAt),Date.now())).wouldVetoIfApproved,false);
    assert.ok((await db.query("SELECT payload FROM authorized_activity WHERE payload ? 'session' OR payload ? 'actor'")).rowCount===0);
    const selected=rows.filter(r=>r.stealth);const metrics=(predict:(r:Record<string,unknown>)=>boolean)=>({tp:selected.filter(r=>r.operator&&predict(r)).length,fp:selected.filter(r=>!r.operator&&predict(r)).length,fn:selected.filter(r=>r.operator&&!predict(r)).length,tn:selected.filter(r=>!r.operator&&!predict(r)).length,abstentions:selected.filter(r=>!predict(r)).length});
    const measured=metrics(r=>!!r.predicted);assert.deepEqual(measured,{tp:2,fp:0,fn:2,tn:6,abstentions:8});
    const baseline=metrics(()=>evaluateOperator([],Date.now()).v3Proposal.wouldVetoIfEnabled);assert.deepEqual(baseline,{tp:0,fp:0,fn:4,tn:6,abstentions:10});
    const summarize=(samples:number[])=>{const sorted=[...samples].sort((a,b)=>a-b);return {n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};};
    await mkdir('test-results/authorized-activity',{recursive:true});await writeFile('test-results/authorized-activity/results.json',JSON.stringify({baseline,measured,notFieldCalibration:true,baselineLatency,latencyMs:{entryBeforeEvidence:summarize(timings.before),entryAfterEvidence:summarize(timings.after),cta:summarize(timings.cta)},observedNetworks:[...observedNetworks],rows},null,2));
    await db.query("UPDATE authorized_activity SET observed_at=clock_timestamp()-interval '8 days'");await emit({...first,id:randomUUID(),observedAt:Date.now()});assert.equal((await db.query('SELECT count(*)::int n FROM authorized_activity')).rows[0].n,1);
  }finally{
    process.env=saved;await browser.close();if(gateway)await new Promise<void>(r=>gateway!.close(()=>r()));await new Promise<void>(r=>copyServer.close(()=>r()));await new Promise<void>(r=>originalServer.close(()=>r()));await db.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();await rm(directory,{recursive:true,force:true});
  }
});
