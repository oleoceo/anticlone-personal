import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import http from 'node:http';
import https from 'node:https';
import { authorizedHosts, collectInfrastructure, publicAddress, validDnsHost, type DnsResolver } from '../apps/infrastructure-dns.js';
import { investigation } from '../apps/investigation.js';
import { assessObservation } from '../apps/risk.js';

const source='controlled-test-resolver';
function fixture(): DnsResolver {
  return {resolve4:async()=>['8.8.8.8'],resolve6:async()=>['2606:4700:4700::1111'],resolveCname:async()=>['edge.owner-domain.com'],resolveNs:async()=>['ns.owner-domain.com']};
}
test('strict DNS authorization and public address policy', () => {
  assert.deepEqual(authorizedHosts({}),[]);
  assert.throws(()=>authorizedHosts({INFRASTRUCTURE_DNS_ENABLED:'1',INFRASTRUCTURE_DNS_HOSTS:'copy.owner-domain.com'}));
  assert.deepEqual(authorizedHosts({INFRASTRUCTURE_DNS_ENABLED:'1',INFRASTRUCTURE_DNS_HOSTS:'copy.owner-domain.com',INFRASTRUCTURE_DNS_SERVER:'8.8.8.8'}),['copy.owner-domain.com']);
  for (const host of ['localhost','127.0.0.1','x.local','x.internal','x.test','-bad.owner-domain.com','a..com','x.owner-domain.com.','UP.owner-domain.com','reserved.example.com']) assert.equal(validDnsHost(host),false,host);
  for (const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','192.0.2.1','::1','::ffff:8.8.8.8','2001:db8::1','fc00::1']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true); assert.equal(publicAddress('2606:4700:4700::1111'),true);
});

test('DNS history is incident-scoped, authorized, bounded, isolated and conservative', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema='dns_'+crypto.randomUUID().replaceAll('-',''); await root.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const host='copy.owner-domain.com', allowed=[host];
  const oldFetch=globalThis.fetch, oldHttpRequest=http.request, oldHttpsRequest=https.request;
  let httpAttempts=0;
  globalThis.fetch=(async()=>{httpAttempts++; throw Error('unexpected HTTP');}) as typeof fetch;
  http.request=(()=>{httpAttempts++; throw Error('unexpected HTTP');}) as typeof http.request;
  https.request=(()=>{httpAttempts++; throw Error('unexpected HTTPS');}) as typeof https.request;
  try {
    await db.query(await readFile('infra/003_projects.sql','utf8'));
    await db.query("INSERT INTO projects(id,name,origin) VALUES('a','A','http://a.test'),('b','B','http://b.test')");
    for (const f of ['001_initial','002_alerts','004_observation_sources','005_canaries','008_traffic_observations','009_risk_assessments','024_risk_evidence','018_notification_budget','019_alert_outbox_expiry','030_infrastructure_dns']) await db.query(await readFile(`infra/${f}.sql`,'utf8'));
    await db.query("INSERT INTO incidents(project_id,host) VALUES('a',$1),('b',$1)",[host]);
    let calls=0; const resolver=fixture(); const base=resolver.resolve4; resolver.resolve4=async h=>{calls++; return base(h);};
    assert.equal(await collectInfrastructure(db,'a',host,[],resolver,source),false);
    assert.equal(await collectInfrastructure(db,'missing',host,allowed,resolver,source),false);
    assert.equal(await collectInfrastructure(db,'a','127.0.0.1',['127.0.0.1'],resolver,source),false);
    assert.equal(calls,0);
    const concurrent=await Promise.all(Array.from({length:5},()=>collectInfrastructure(db,'a',host,allowed,resolver,source)));
    assert.equal(concurrent.filter(Boolean).length,1); assert.ok(calls>=1 && calls<=5);
    const restarted=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
    try { assert.equal(await collectInfrastructure(restarted,'a',host,allowed,fixture(),source),false); } finally { await restarted.end(); }
    assert.equal((await db.query('SELECT count(*)::int n FROM infrastructure_dns_observations')).rows[0].n,4);
    let row=(await investigation(db,'a'))[0]; assert.equal(row.infrastructure.dns.length,4); assert.equal(row.infrastructure.asn,'NOT_AVAILABLE');
    assert.ok(row.infrastructure.dns.every((x:{validity:string})=>x.validity==='UNKNOWN'));
    assert.equal((await investigation(db,'b'))[0].infrastructure.dns.length,0);
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '14 hours'");
    const failing=fixture(); failing.resolve4=async()=>{throw Object.assign(Error('offline'),{code:'ESERVFAIL'});};
    failing.resolve6=async()=>new Promise(()=>{});
    failing.resolveCname=async()=>['evil.local']; failing.resolveNs=async()=>['ns2.owner-domain.com'];
    assert.equal(await collectInfrastructure(db,'a',host,allowed,failing,source),true);
    let records=(await db.query('SELECT record_type,state FROM infrastructure_dns_observations ORDER BY id DESC LIMIT 4')).rows;
    assert.equal(records.find(r=>r.record_type==='A').state,'INVALID');
    assert.equal(records.find(r=>r.record_type==='AAAA').state,'INVALID');
    assert.equal(records.find(r=>r.record_type==='CNAME').state,'INVALID');
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours' WHERE observed_at>now()-interval '6 hours'");
    const changed=fixture(); changed.resolve4=async()=>['1.1.1.1']; changed.resolveCname=async()=>['other.owner-domain.com']; changed.resolveNs=async()=>['ns3.owner-domain.com'];
    assert.equal(await collectInfrastructure(db,'a',host,allowed,changed,source),true);
    row=(await investigation(db,'a'))[0];
    for (const type of ['A','CNAME','NS']) assert.ok(row.infrastructure.dns.some((x:{record_type:string;changed:boolean})=>x.record_type===type && x.changed));
    assert.equal(assessObservation({source:'browser',reliability:'uncorroborated',trafficClass:'DIRECT_UNKNOWN',kind:'none'},false).level,'UNCERTAIN');
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours'");
    const equivalent=fixture(); equivalent.resolve4=changed.resolve4; equivalent.resolveCname=changed.resolveCname; equivalent.resolveNs=changed.resolveNs;
    equivalent.resolve6=async()=>['2606:4700:4700:0:0:0:0:1111'];
    await collectInfrastructure(db,'a',host,allowed,equivalent,source);
    const ipv6=(await investigation(db,'a'))[0].infrastructure.dns.find((x:{record_type:string})=>x.record_type==='AAAA');
    assert.equal(ipv6.changed,false);
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours'");
    const excessive=fixture(); excessive.resolveCname=async()=>Array.from({length:33},(_,i)=>`edge${i}.owner-domain.com`);
    await collectInfrastructure(db,'a',host,allowed,excessive,source);
    assert.equal((await db.query("SELECT state FROM infrastructure_dns_observations WHERE record_type='CNAME' ORDER BY id DESC LIMIT 1")).rows[0].state,'INVALID');
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours'");
    const removed=fixture(); removed.resolveCname=async()=>{throw Object.assign(Error('no data'),{code:'ENODATA'});};
    removed.resolveNs=async()=>[];
    await collectInfrastructure(db,'a',host,allowed,removed,source);
    const afterRemoval=(await investigation(db,'a'))[0].infrastructure.dns;
    for (const type of ['CNAME','NS']) assert.ok(afterRemoval.some((x:{record_type:string;state:string;changed:boolean})=>x.record_type===type && x.state==='NO_DATA' && x.changed));
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '31 days'");
    const invalid=fixture(); invalid.resolve4=async()=>['169.254.169.254']; invalid.resolve6=async()=>{throw Object.assign(Error('timeout'),{code:'ETIMEOUT'});};
    await collectInfrastructure(db,'a',host,allowed,invalid,source);
    records=(await db.query('SELECT record_type,state FROM infrastructure_dns_observations')).rows;
    assert.equal(records.length,4); assert.equal(records.find(r=>r.record_type==='A').state,'INVALID'); assert.equal(records.find(r=>r.record_type==='AAAA').state,'TIMEOUT');
    await db.query(`INSERT INTO infrastructure_dns_observations(incident_id,project_id,host,record_type,result,source,state,valid_until,limitations,observed_at)
      SELECT i.id,'a',$1,'NS','[]'::jsonb,$2,'ERROR',now(),'test',now()-interval '10 hours' FROM incidents i CROSS JOIN generate_series(1,125) WHERE i.project_id='a' AND i.host=$1`,[host,source]);
    await db.query("UPDATE infrastructure_dns_observations SET observed_at=now()-interval '7 hours' WHERE project_id='a'");
    await collectInfrastructure(db,'a',host,allowed,fixture(),source);
    assert.equal((await db.query("SELECT count(*)::int n FROM infrastructure_dns_observations WHERE project_id='a'")).rows[0].n,120);
    await db.query('ALTER TABLE infrastructure_dns_observations RENAME TO absent_dns');
    assert.equal((await investigation(db,'a'))[0].infrastructure.available,false);
    assert.equal(httpAttempts,0);
  } finally { globalThis.fetch=oldFetch; http.request=oldHttpRequest; https.request=oldHttpsRequest; await db.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
});
