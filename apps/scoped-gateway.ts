import {copyPath,recordCopyDecision,redirectVisit,rememberCopyContext} from './page-copy-contexts.js';
import { copyRedirectAdmission } from './page-redirect-rules.js';
import { operationalAuthorization } from './operational-authorization.js';
import { issueEntryReceipt, issueObservedReceipt } from './observed-receipts.js';
import { withAttribution } from './attribution.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { configuredOrigin, observe } from './detection.js';
import { classifyTraffic } from './traffic.js';
import { resolvePageContext } from './page-context.js';
import { ctaDecision } from './cta-policy.js';
import { evaluateEntryPolicy } from './page-redirect.js';
import { assessObservation, investigateRisk, preserveLegacyRiskHistory, safeEvaluateRisk } from './risk.js';
import { currentApproval } from './page-policy-approval.js';
import { projectMaintenance } from './project-maintenance.js';
import { operationallyEligible } from './operational-eligibility.js';
import type { LayerObserver } from './runtime-layer-observations.js';
import {receiveRuntimeReceipt,receiptAliases} from './investigation-receipts.js';
import {scheduleOperatorShadow} from './operator-shadow.js';

// Identifiers in these routes are correlation handles, never credentials.
export function scopedGateway(db: Pool, scripts: Record<string, Buffer>, collect=projectMaintenance(db,{SMTP_PORT:'1'}).collect, layers:LayerObserver=async()=>{}) {
  const operational=process.env.GATEWAY_MODE==='OPERATIONAL';
  if(operational && Object.keys(process.env).some(key=>/^(SCOPED_LAB_|LAB_CONTROLLED_)/.test(key)&&process.env[key]))throw Error('laboratory configuration forbidden operationally');
  const fixtureId=process.env.SCOPED_LAB_INSTALLATION;
  const fixtureIds=(process.env.SCOPED_LAB_INSTALLATIONS ?? fixtureId ?? "").split(",").filter(Boolean);
  if (process.env.GATEWAY_MODE==='PILOT_OBSERVE' && fixtureIds.length) throw Error('scoped laboratory fixtures forbidden in pilot');
  if (fixtureIds.length>100 || fixtureIds.some(id=>!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))) throw Error("invalid scoped lab installations");
  const fixtureOrigin=process.env.SCOPED_LAB_ORIGIN ? configuredOrigin(process.env.SCOPED_LAB_ORIGIN) : undefined;
  if ((fixtureIds.length || fixtureOrigin) && (!fixtureIds.length || !fixtureOrigin || !['localhost','127.0.0.1'].includes(new URL(fixtureOrigin).hostname))) throw Error('invalid scoped lab fixture');
  if (process.env.SCOPED_LAB_RISK && (!fixtureIds.length || !['LOW','HIGH','UNCERTAIN','ERROR'].includes(process.env.SCOPED_LAB_RISK))) throw Error('invalid scoped laboratory risk');
  let start = Date.now(), count = 0;
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const match = /^\/i\/([0-9a-f-]{36})\/(runtime\.js|core\.js|fallback\.js|observe|observe\/fallback|entry-decision|cta-refresh)$/i.exec(req.url ?? '');
    if (!match) return false;
    const receivedAt=Date.now(), startedAt=performance.now();
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
          let diagnostic: {project: string; page: string; origin: string; pathname: string} | undefined;
          let reason = operational ? 'NO_COPY_RULE' : 'GATEWAY_OBSERVE';
          let version: number | null = null;
          let visit: string | null = null;
          const respond = <T extends {action:string}>(result: T) => {
            res.appendHeader('Server-Timing',`decision;dur=${(performance.now()-startedAt).toFixed(1)}`);
            res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
            if(diagnostic && endpoint==='entry-decision')void recordCopyDecision(db,diagnostic,{receivedAt,visit,action:result.action,reason,version});
          };
          const fallback = () => respond({action:'OBSERVE_ONLY'});
          if (Object.keys(fields).sort().join(',')!=='pathname,session,signals' || typeof fields.pathname!=='string' ||
              !copyPath.test(fields.pathname) || typeof fields.session!=='string' || !redirectVisit.test(fields.session)) { fallback(); return; }
          if (endpoint==='entry-decision') {
            const marker = /;\s*ac-visit=([a-f0-9]{32})(?=;|$)/.exec(req.headers['content-type'] ?? '');
            visit=marker?.[1] ?? null;
          }
          const origin=configuredOrigin(req.headers.origin ?? '');
          const traffic=classifyTraffic(fields.signals,origin);
          let copyRule = false;
          if (operational && endpoint==='entry-decision') {
            const copy = await copyRedirectAdmission(db,match[1],origin,fields.pathname);
            copyRule = copy !== null;
            if (copy) {
              diagnostic={project:copy.project,page:copy.page,origin,pathname:fields.pathname};
              version=copy.version;
              reason=copy.eligibility;
            }
            if (copy?.admitted) {
              const evidence={source:'browser' as const,reliability:'uncorroborated' as const,trafficClass:traffic.trafficClass,kind:traffic.evidence};
              const assessment=safeEvaluateRisk(false,()=>assessObservation(evidence,false));
              const evaluated=evaluateEntryPolicy({...copy,enabled:true},copy.original,origin,origin,assessment?.level ?? 'UNCERTAIN',
                fields.session,traffic.trafficClass,assessment);
              reason=evaluated.reason;
              const decision=evaluated.decision;
              if (decision.action==='PAGE_REDIRECT') {
                const result=await issueEntryReceipt(db,copy.project,copy.page,origin,fields.session,traffic.trafficClass,
                  withAttribution(decision,copy.project,copy.page,copy.original));
                respond({...result,operationalContext:{origin,pathname:fields.pathname,original:copy.original}});
                void investigateRisk(db,copy.project,new URL(origin).hostname,assessment,evidence);
                scheduleOperatorShadow(db,copy.project,copy.page,new URL(origin).hostname,fields.session,traffic.trafficClass,receivedAt);
                return;
              }
            }
          }
          const client=await db.connect();
          let released=false;
          try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const context=await resolvePageContext(client,match[1]);
          if (context && !diagnostic) diagnostic={project:context.project,page:context.page,origin,pathname:fields.pathname};
          if (!context || context.urls.length!==1 || !await operationallyEligible(client,context.project,context.page,true)) {
            if (!copyRule) reason='PAGE_INACTIVE';
            fallback(); return;
          }
          const approval=await currentApproval(client,context.project,context.page);
          if (!approval) { if (!copyRule && operational) reason='APPROVAL_REQUIRED'; fallback(); return; }
          const original=context.urls[0];
          const authorization=operational ? await operationalAuthorization(client,context.project,context.page,origin,fields.pathname) : null;
          const official=operational ? await client.query('SELECT 1 FROM protected_page_urls WHERE origin=$1 UNION ALL SELECT 1 FROM projects WHERE origin=$1',[origin]) : null;
          const operationalContext=authorization && !official?.rowCount ? {origin,pathname:fields.pathname,original:original.origin} : null;
          const decisionOrigin=operationalContext ? origin : fixtureOrigin;
          const evidence={source:'browser' as const,reliability:'uncorroborated' as const,trafficClass:traffic.trafficClass,kind:traffic.evidence};
          const controlled=fixtureIds.some(id=>id.toLowerCase()===match[1].toLowerCase()) && origin===fixtureOrigin && ['localhost','127.0.0.1'].includes(new URL(original.origin).hostname) && origin!==original.origin;
          const assessment=safeEvaluateRisk(controlled && !['UNCERTAIN','HIGH','ERROR'].includes(process.env.SCOPED_LAB_RISK ?? ''),fixture=>{
            if (controlled && process.env.SCOPED_LAB_RISK==='ERROR') throw Error('controlled evaluator failure');
            return controlled && process.env.SCOPED_LAB_RISK==='HIGH' ? {...assessObservation(evidence,true),level:'HIGH'} : assessObservation(evidence,fixture);
          });
          const recorded=investigateRisk(db,context.project,new URL(origin).hostname,assessment,evidence);
          const finish=async (decision:{action:string;stealthVersion?:number}) => {
            await client.query('COMMIT'); client.release(); released=true;
            const eligible=await preserveLegacyRiskHistory(decision,recorded);
            const issueReceipt = eligible.action==='PAGE_REDIRECT' ? issueEntryReceipt : issueObservedReceipt;
            const result=await issueReceipt(db,context.project,context.page,origin,fields.session,traffic.trafficClass,withAttribution(eligible,context.project,context.page,original.origin));
            scheduleOperatorShadow(db,context.project,context.page,new URL(origin).hostname,fields.session as string,traffic.trafficClass,receivedAt);
            respond(operationalContext && result.action!=='OBSERVE_ONLY' ? {...result,operationalContext} : result);
          };
          if (!controlled && !operationalContext) {
            if (!copyRule && operational) reason='CONTEXT_EXCLUDED';
            await finish({action:'OBSERVE_ONLY'}); return;
          }
          if (endpoint==='entry-decision' && !copyRule && approval.entryVersion!==null) {
            const result=await client.query(`SELECT v.version,v.enabled,v.approved_destination,v.allocation,to_jsonb(v)->'stealth' AS stealth,to_jsonb(v)->'stealth_version' AS stealth_version FROM page_entry_policy_bindings b JOIN protection_policy_versions v ON v.project_id=b.project_id AND v.version=b.version WHERE b.project_id=$1 AND b.page_id=$2`,[context.project,context.page]);
            const policy=result.rows[0];
            const evaluated=evaluateEntryPolicy(policy,original.origin,origin,decisionOrigin,assessment?.level ?? 'UNCERTAIN',
              fields.session,traffic.trafficClass,assessment);
            version=policy?.version ?? null;
            reason=evaluated.decision.action==='PAGE_REDIRECT' ? 'LEGACY_RULE' : evaluated.reason;
            if (evaluated.decision.action==='PAGE_REDIRECT') { await finish(evaluated.decision); return; }
          }
          const result=await ctaDecision(db,context.project,original.origin,origin,decisionOrigin,assessment?.level ?? 'UNCERTAIN',fields.session,traffic.trafficClass,original.pathname,fields.pathname,context.page,client,assessment);
          await finish(result); return;
          } finally { if (!released) { try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); } } }
        }
        const core = endpoint === 'observe';
        if (Object.keys(fields).sort().join(',') !== (core ? 'origin,pathname,signals' : 'origin,pathname') || typeof fields.origin !== 'string' || typeof fields.pathname !== 'string' || fields.pathname.length>1024) throw new TypeError('invalid');
        const origin=configuredOrigin(fields.origin);
        if (!req.headers.origin || configuredOrigin(req.headers.origin)!==origin) throw new TypeError('invalid');
        const url=new URL(origin+fields.pathname);
        if (url.origin!==origin || url.pathname!==fields.pathname || url.search || url.hash || !fields.pathname.startsWith('/')) throw new TypeError('invalid');
        if (core) classifyTraffic(fields.signals,origin);
        const client=await db.connect();
        let context:Awaited<ReturnType<typeof resolvePageContext>>=null;
        try {
          await client.query('BEGIN');
          context=await resolvePageContext(client,match[1]);
          if (!context) { res.writeHead(404).end(); return; }
          if (!await operationallyEligible(client,context.project,context.page,true)) { res.writeHead(204).end(); return; }
          const authorized=context.urls.some(value => value.origin===origin && value.pathname===url.pathname);
          const result=await observe(db,context.project,authorized ? [origin] : [],origin,core ? 'core' : 'fallback',core ? fields.signals : undefined);
          receiveRuntimeReceipt(db,context,endpoint,core?'core':'fallback',new URL(origin).hostname,receiptAliases.get(req));
          if (authorized) await collect(context.project,context.page,origin,core ? 'core':'fallback');
          res.writeHead(result==='capacity' ? 429 : 204).end();
          if (!authorized && result!=='capacity') void rememberCopyContext(db,{...context,origin,pathname:url.pathname});
          void layers(context,origin,core?'core':'fallback',result==='capacity').catch(()=>{});
        } catch(error) {
          if(context) void layers(context,origin,core?'core':'fallback',true).catch(()=>{});
          throw error;
        } finally { try { await client.query('ROLLBACK'); client.release(); } catch { client.release(true); } }
      })().catch((error:unknown) => decision ? res.writeHead(200,{'Content-Type':'application/json'}).end('{"action":"OBSERVE_ONLY"}') : res.writeHead(error instanceof TypeError || error instanceof SyntaxError ? 400 : 503).end());
    });
    return true;
  };
}
