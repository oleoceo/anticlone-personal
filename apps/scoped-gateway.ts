import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { configuredOrigin, observe } from './detection.js';
import { classifyTraffic } from './traffic.js';
import { resolvePageContext } from './page-context.js';
import { ctaDecision } from './cta-policy.js';
import { entryDecision, approvedDestination } from './page-redirect.js';
import { validateAllocation } from './allocation.js';
import { assessObservation, recordRisk, safeEvaluateRisk, stealthEligible } from './risk.js';
import { currentApproval } from './page-policy-approval.js';

// Identifiers in these routes are correlation handles, never credentials.
export function scopedGateway(db: Pool, scripts: Record<string, Buffer>) {
  const fixtureId=process.env.SCOPED_LAB_INSTALLATION;
  const fixtureOrigin=process.env.SCOPED_LAB_ORIGIN ? configuredOrigin(process.env.SCOPED_LAB_ORIGIN) : undefined;
  if ((fixtureId || fixtureOrigin) && (!fixtureId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(fixtureId) || !fixtureOrigin || !['localhost','127.0.0.1'].includes(new URL(fixtureOrigin).hostname))) throw Error('invalid scoped lab fixture');
  let start = Date.now(), count = 0;
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const match = /^\/i\/([0-9a-f-]{36})\/(runtime\.js|core\.js|fallback\.js|observe|observe\/fallback|entry-decision|cta-refresh)$/i.exec(req.url ?? '');
    if (!match) return false;
    res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Cache-Control','no-store');
    if (Date.now()-start >= 60_000) { start=Date.now(); count=0; }
    if (++count > 1200) { res.writeHead(429).end(); return true; }
    const endpoint = match[2];
    if (req.method === 'GET' && scripts[endpoint]) {
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'}).end(scripts[endpoint]); return true;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    const decision = endpoint === 'entry-decision' || endpoint === 'cta-refresh';
    if (!['observe','observe/fallback','entry-decision','cta-refresh'].includes(endpoint) || !/^text\/plain(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return true; }
    const chunks: Buffer[] = []; let size=0, rejected=false;
    req.on('data',(chunk:Buffer) => { size+=chunk.length; if (size>2048) { if (!rejected) res.writeHead(413).end(); rejected=true; chunks.length=0; } else if (!rejected) chunks.push(chunk); });
    req.on('end',() => {
      if (rejected) return;
      void (async () => {
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid');
        const fields = input as Record<string,unknown>;
        if (decision) {
          const fallback = () => res.writeHead(200,{'Content-Type':'application/json'}).end('{"action":"OBSERVE_ONLY"}');
          if (Object.keys(fields).sort().join(',') !== 'pathname,session,signals' || typeof fields.pathname !== 'string' || !/^\/[a-zA-Z0-9/_-]{0,200}$/.test(fields.pathname) || typeof fields.session !== 'string' || !/^[a-f0-9]{32}$/.test(fields.session)) { fallback(); return; }
          const origin=configuredOrigin(req.headers.origin ?? '');
          const traffic=classifyTraffic(fields.signals,origin);
          const client=await db.connect();
          try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const context=await resolvePageContext(client,match[1]);
          if (!context || context.urls.length!==1) { fallback(); return; }
          const approval=await currentApproval(client,context.project,context.page);
          if (!approval) { fallback(); return; }
          const original=context.urls[0];
          const evidence={source:'browser' as const,reliability:'uncorroborated' as const,trafficClass:traffic.trafficClass,kind:traffic.evidence};
          const controlled=match[1].toLowerCase()===fixtureId?.toLowerCase() && origin===fixtureOrigin && ['localhost','127.0.0.1'].includes(new URL(original.origin).hostname) && origin!==original.origin;
          const assessment=safeEvaluateRisk(controlled,fixture=>assessObservation(evidence,fixture));
          if (!assessment) { fallback(); return; }
          void recordRisk(db,context.project,new URL(origin).hostname,assessment,evidence).catch(()=>{});
          if (!stealthEligible(assessment,false)) { fallback(); return; }
          if (endpoint==='entry-decision' && approval.entryVersion!==null) {
            const result=await client.query('SELECT v.version,v.enabled,v.approved_destination,v.allocation FROM active_protection_policies a JOIN protection_policy_versions v ON v.project_id=a.project_id AND v.version=a.version JOIN page_entry_policy_bindings b ON b.project_id=a.project_id AND b.version=a.version WHERE a.project_id=$1 AND b.page_id=$2 AND v.stealth=true',[context.project,context.page]);
            const policy=result.rows[0];
            if (policy?.enabled) { approvedDestination(policy.approved_destination,original.origin); validateAllocation(policy.allocation); }
            const entry=entryDecision(policy,original.origin,origin,fixtureOrigin,assessment.level,fields.session,traffic.trafficClass);
            if (entry.action==='PAGE_REDIRECT') { res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(entry)); return; }
          }
          const result=await ctaDecision(db,context.project,original.origin,origin,fixtureOrigin,assessment.level,fields.session,traffic.trafficClass,original.pathname,fields.pathname,context.page,client);
          res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result)); return;
          } finally { try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); } }
        }
        const core = endpoint === 'observe';
        if (Object.keys(fields).sort().join(',') !== (core ? 'origin,pathname,signals' : 'origin,pathname') || typeof fields.origin !== 'string' || typeof fields.pathname !== 'string' || fields.pathname.length>1024) throw new TypeError('invalid');
        const origin=configuredOrigin(fields.origin);
        if (!req.headers.origin || configuredOrigin(req.headers.origin)!==origin) throw new TypeError('invalid');
        const url=new URL(origin+fields.pathname);
        if (url.origin!==origin || url.pathname!==fields.pathname || url.search || url.hash || !fields.pathname.startsWith('/')) throw new TypeError('invalid');
        if (core) classifyTraffic(fields.signals,origin);
        const context=await resolvePageContext(db,match[1]);
        if (!context) { res.writeHead(404).end(); return; }
        const authorized=context.urls.some(value => value.origin===origin && value.pathname===url.pathname);
        const result=await observe(db,context.project,authorized ? [origin] : [],origin,core ? 'core' : 'fallback',core ? fields.signals : undefined);
        res.writeHead(result==='capacity' ? 429 : 204).end();
      })().catch((error:unknown) => decision ? res.writeHead(200,{'Content-Type':'application/json'}).end('{"action":"OBSERVE_ONLY"}') : res.writeHead(error instanceof TypeError || error instanceof SyntaxError ? 400 : 503).end());
    });
    return true;
  };
}
