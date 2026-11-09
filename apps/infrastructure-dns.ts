import { operationallyEligible } from './operational-eligibility.js';
import { tryRecordTimeline } from './investigation-timeline.js';
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Pool } from 'pg';

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'NS';
export interface DnsResolver { resolve4(host:string): Promise<string[]>; resolve6(host:string): Promise<string[]>; resolveCname(host:string): Promise<string[]>; resolveNs(host:string): Promise<string[]>; }
const types: RecordType[] = ['A','AAAA','CNAME','NS'];
const blocked = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as [string,number][]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as [string,number][]) blocked.addSubnet(address,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(value:string): boolean {
  const family = isIP(value);
  if (family === 4) return !blocked.check(value,'ipv4');
  return family === 6 && globalV6.check(value,'ipv6') && !blocked.check(value,'ipv6');
}
export function validDnsHost(value:string): boolean {
  if (value !== value.toLowerCase() || value.length > 253 || isIP(value) || value.endsWith('.') || !value.includes('.')) return false;
  if (['example.com','example.net','example.org'].some(domain => value === domain || value.endsWith('.'+domain))) return false;
  const parts = value.split('.');
  if (parts.some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return false;
  const suffix = parts.at(-1)!;
  return /^[a-z]{2,63}$/.test(suffix) && !['local','localhost','internal','home','lan','test','invalid','example','onion','arpa'].includes(suffix);
}
export function realResolver(server:string): DnsResolver {
  if (isIP(server) !== 4 || !publicAddress(server)) throw Error('DNS resolver must be an explicit public IPv4 address');
  const resolver = new Resolver({timeout:1200,tries:1}); resolver.setServers([server]); return resolver;
}
export function authorizedHosts(env:NodeJS.ProcessEnv): string[] {
  if (env.INFRASTRUCTURE_DNS_ENABLED !== '1') return [];
  const hosts = (env.INFRASTRUCTURE_DNS_HOSTS ?? '').split(',');
  if (!env.INFRASTRUCTURE_DNS_SERVER || hosts.length > 20 || hosts.some(host => !validDnsHost(host)) || new Set(hosts).size !== hosts.length) throw Error('invalid infrastructure DNS authorization');
  return hosts;
}
async function resolveType(resolver:DnsResolver, host:string, type:RecordType): Promise<{state:string;result:string[]}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = type === 'A' ? resolver.resolve4(host) : type === 'AAAA' ? resolver.resolve6(host) : type === 'CNAME' ? resolver.resolveCname(host) : resolver.resolveNs(host);
    const values = await Promise.race([query, new Promise<never>((_,reject) => { timer=setTimeout(() => reject(Object.assign(Error('timeout'),{code:'TIMEOUT'})),1500); })]);
    if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string')) return {state:'INVALID',result:[]};
    const normalized = values.map(value => type === 'A' || type === 'AAAA' ? (type === 'AAAA' && isIP(value) === 6 ? new URL('http://['+value+']/').hostname.slice(1,-1) : value.toLowerCase()) : value.toLowerCase().replace(/\.$/,'')).sort();
    if (normalized.some(value => type === 'A' ? isIP(value)!==4 || !publicAddress(value) : type === 'AAAA' ? isIP(value)!==6 || !publicAddress(value) : !validDnsHost(value)) || type === 'CNAME' && normalized.length > 1 || normalized.includes(host)) return {state:'INVALID',result:[]};
    return {state:normalized.length ? 'OK' : 'NO_DATA',result:[...new Set(normalized)]};
  } catch (error) {
    const code = (error as {code?:string}).code;
    return {state:code === 'TIMEOUT' || code === 'ETIMEOUT' ? 'TIMEOUT' : code === 'ENODATA' ? 'NO_DATA' : code === 'ENOTFOUND' ? 'NOT_AVAILABLE' : 'ERROR',result:[]};
  } finally { if (timer) clearTimeout(timer); }
}

// Authorization is independent of the incident claim. Never follows CNAMEs or connects to the host.
export async function collectInfrastructure(pool:Pool, project:string, host:string, authorized:readonly string[], resolver:DnsResolver, source:string): Promise<boolean> {
  if (!validDnsHost(host) || !authorized.includes(host) || !/^configured-dns:[0-9.]{7,15}$/.test(source) && source !== 'controlled-test-resolver') return false;
  // Cheap preflight only: no transaction, checked-out client or state lock in DNS I/O.
  if (!await operationallyEligible(pool,project)) return false;
  const incident = await pool.query("SELECT id FROM incidents WHERE project_id=$1 AND host=$2 AND last_seen>=now()-interval '30 days'",[project,host]);
  if (!incident.rowCount) return false;
  const recent = await pool.query("SELECT 1 FROM infrastructure_dns_observations WHERE project_id=$1 AND host=$2 AND observed_at>now()-interval '6 hours' LIMIT 1",[project,host]);
  if (recent.rowCount) return false;
  const results = await Promise.all(types.map(type => resolveType(resolver,host,type)));
  if (results[2].state === 'INVALID') for (const i of [0,1]) { results[i] = {state:'INVALID',result:[]}; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await operationallyEligible(client,project,undefined,true)) { await client.query('ROLLBACK'); return false; }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('infrastructure-dns'),hashtext($1))",[project]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[project]);
    const stillExists = await client.query("SELECT 1 FROM incidents WHERE id=$1 AND project_id=$2 AND host=$3 AND last_seen>=now()-interval '30 days'",[incident.rows[0].id,project,host]);
    if (!stillExists.rowCount) { await client.query('ROLLBACK'); return false; }
    // Another collector may have persisted while this resolver was running.
    const collected=await client.query("SELECT 1 FROM infrastructure_dns_observations WHERE project_id=$1 AND host=$2 AND observed_at>now()-interval '6 hours' LIMIT 1",[project,host]);
    if (collected.rowCount) {await client.query('ROLLBACK');return false;}
    for (let i=0;i<types.length;i++) {
      const prior=await client.query('SELECT state,result,source FROM infrastructure_dns_observations WHERE project_id=$1 AND host=$2 AND record_type=$3 ORDER BY observed_at DESC,id DESC LIMIT 1',[project,host,types[i]]);
      const saved=await client.query(`INSERT INTO infrastructure_dns_observations(incident_id,project_id,host,record_type,result,source,state,valid_until,limitations) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8) RETURNING id`,[incident.rows[0].id,project,host,types[i],JSON.stringify(results[i].result),source,results[i].state,'DNS response is not proof of identity or operator; TTL unavailable; current validity unknown. CNAME chains are not followed or verified.']);
      if (prior.rowCount && prior.rows[0].source===source && ['OK','NO_DATA'].includes(prior.rows[0].state) && ['OK','NO_DATA'].includes(results[i].state) && (prior.rows[0].state!==results[i].state || JSON.stringify(prior.rows[0].result)!==JSON.stringify(results[i].result)))
        await tryRecordTimeline(client,{project,host,type:'dns_change',source:source==='controlled-test-resolver' ? source : 'configured-dns',provenance:'infrastructure',reference:'dns:'+saved.rows[0].id,summary:{record_type:types[i],previous_state:prior.rows[0].state,state:results[i].state},confidence:'resolver_response',limitations:'Comparable DNS responses changed; TTL and current validity unknown; not identity.'});
    }
    await client.query("DELETE FROM infrastructure_dns_observations WHERE project_id=$1 AND (observed_at<now()-interval '30 days' OR id IN (SELECT id FROM infrastructure_dns_observations WHERE project_id=$1 AND host=$2 ORDER BY observed_at DESC,id DESC OFFSET 120))",[project,host]);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
