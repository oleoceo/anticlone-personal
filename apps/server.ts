import { authorizedHosts, collectInfrastructure, realResolver } from './infrastructure-dns.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { projectMaintenance } from './project-maintenance.js';
import { checkoutWebhook, projectCheckoutWebhooks } from './checkout-webhook.js';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { configuredOrigin, hostFromUrl, cleanup, observe, observeCanary } from './detection.js';
import { deliverOne } from './alerts.js';
import { smtpProvider } from './smtp-provider.js';
import { classifyTraffic } from './traffic.js';
import { entryDecision, approvedDestination } from './page-redirect.js';
import { validateAllocation } from './allocation.js';
import { ctaDecision } from './cta-policy.js';
import { safeEvaluateRisk, assessObservation, recordRisk, stealthEligible, type RiskEvidence } from './risk.js';
import { gatewayMode } from './gateway-mode.js';
import { gatewayBoundary } from './gateway-boundary.js';
import { recordInstallationClaim } from './installation.js';
import { recordDegradationClaim, degradationState, maintainDegradation, markDegradationGap } from './degradation.js';
import { optionalSchemas } from './optional-schema.js';
import { evaluateInactivity, deliverHealth, reconcileOperationalEpisode, recoverOperationalSource, maintainHealthHistory, invalidateInactivity, recordInstallationActivity } from './health-alerts.js';
import { OperationalObservations } from './operational-observations.js';
import { scopedGateway } from './scoped-gateway.js';
import { legacyOperationallyEligible } from './operational-eligibility.js';
const boundary = gatewayBoundary(process.env);
const connectionString = process.env.DATABASE_URL, project = process.env.PROJECT_ID;
const smtpPort = Number(process.env.SMTP_PORT), port = Number(process.env.PORT ?? 3000);
const cloneSmtp = smtpProvider(process.env);
if (!connectionString || (project !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(project)) || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid local test configuration');
const activeProject: string = project ?? '';
// Multiproject observation is currently a laboratory-only checkpoint.
if (!project && (process.env.GATEWAY_MODE === 'PILOT_OBSERVE' || process.env.GATEWAY_TRANSPORT || process.env.ALLOWED_ORIGIN || process.env.LAB_CONTROLLED_ORIGIN || process.env.LAB_CONTROLLED_RISK)) throw Error('multiproject pilot configuration unavailable');
const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 4000 });
if (cloneSmtp) await pool.query('SELECT outbox_id,attempt,transport,started_at,finished_at,outcome FROM clone_delivery_attempts LIMIT 0');
pool.on('error', () => process.stderr.write('database connection failed\n'));
if (process.env.GATEWAY_MODE === 'PILOT_OBSERVE' && (process.env.ALLOWED_ORIGIN || process.env.LAB_CONTROLLED_ORIGIN || process.env.LAB_CONTROLLED_RISK)) throw Error('laboratory configuration forbidden in pilot');
// One-time legacy import is driven solely by the local operator's old configuration.
const legacyOrigin = process.env.ALLOWED_ORIGIN && configuredOrigin(process.env.ALLOWED_ORIGIN);
if (legacyOrigin && project) {
  await pool.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2) ON CONFLICT (id) DO NOTHING', [activeProject, legacyOrigin]);
}
await pool.query('SELECT project_id, host, day, traffic_class, evidence, certainty, source, observed_at FROM traffic_observation_days LIMIT 0');
await pool.query('SELECT project_id,host,day,level,evaluator_version,source,reason,confidence,evidence_kind,evidence_provenance,evidence_reliability,observed_at FROM risk_assessment_days LIMIT 0');
const projectRow = project ? await pool.query('SELECT origin FROM projects WHERE id=$1', [activeProject]) : null;
if (project && projectRow?.rowCount !== 1) throw new Error('unknown project');
const normalizedOrigin = projectRow ? configuredOrigin(projectRow.rows[0].origin) : 'http://localhost';
const mode = project ? gatewayMode(process.env, normalizedOrigin) : {pilot:true,origins:[]};
let healthBaselineVersion = 1, healthBaselinePersisted = 0;
const failures = new OperationalObservations();
function observeFailure(source: string, failed: boolean, code?: string) {
  if (source==='installation_claim' && failed) healthBaselineVersion++;
  failures.observe(source,failed,code);
}
const optional = await optionalSchemas(pool,observeFailure);
// Explicit operator authorization is required even when a host already has an incident.
const dnsHosts = authorizedHosts(process.env);
const dnsResolver = dnsHosts.length ? realResolver(process.env.INFRASTRUCTURE_DNS_SERVER!) : undefined;
let dnsIndex = 0, dnsBusy = false, dnsRetentionAfter = 0;
if (legacyOrigin && legacyOrigin !== normalizedOrigin) throw new Error('legacy configuration conflicts with project');
// The operator controls this local experiment; requests never provide risk.
const controlledOrigin = process.env.LAB_CONTROLLED_ORIGIN ? configuredOrigin(process.env.LAB_CONTROLLED_ORIGIN) : undefined;
if (controlledOrigin && (!['127.0.0.1', 'localhost'].includes(new URL(controlledOrigin).hostname) || !['127.0.0.1', 'localhost'].includes(new URL(normalizedOrigin).hostname))) throw new Error('lab origins must be loopback');
const bootstrap = readFileSync('runtime/bootstrap.js');
const core = readFileSync('runtime/core.js');
const inventoryScript = readFileSync('runtime/cta-inventory.js');
const fallback = readFileSync('runtime/fallback.js');
const maintainProjects = projectMaintenance(pool,process.env,project);
const scoped = scopedGateway(pool, {'runtime.js':bootstrap,'core.js':core,'fallback.js':fallback},async(id,page,origin,source)=>{
  const key='scoped_'+randomUUID();
  if (id===project) claimPending.add(key);
  try { const ok=await maintainProjects.collect(id,page,origin,source); if (id===project) observeFailure('installation_claim',!ok); return ok; }
  finally { if (id===project) claimPending.delete(key); }
});
let windowStart = Date.now(), count = 0;
let decisionWindowStart = Date.now(), decisionCount = 0;
let refreshWindowStart = Date.now(), refreshCount = 0;
let activityPending = false, activityAfter = 0;
const claimPending = new Set<string>();
const claimAfter = new Map<string,number>();
// Serialize F44 work so an observed collection failure is recorded before any
// later diagnosis. On restart the preceding collection interval is unknown.
let degradationQueue: Promise<void> = Promise.resolve();
let degradationQueued = 0;
let degradationGapVersion = 1, degradationGapRecorded = 0;
let gapBarrier: Promise<boolean> | undefined;
function degradationTask(operation: string, action: () => Promise<unknown>, force = false): Promise<boolean> {
  if (optional.canaryDegradation.state === 'NOT_INSTALLED' || !controlledOrigin || mode.pilot)
    return optional.degradation.run(operation, action);
  if (!force && degradationQueued >= 100) { degradationGapVersion++; return Promise.resolve(false); }
  degradationQueued++;
  let completed = false;
  const task = degradationQueue.then(async () => {
    completed = await optional.degradation.run(operation, async () => {
      try {
        if (degradationGapRecorded !== degradationGapVersion) {
          const version = degradationGapVersion;
          await markDegradationGap(pool,activeProject); degradationGapRecorded = version;
        }
        await action();
      } catch (error) { degradationGapVersion++; throw error; }
    });
  }).finally(() => { degradationQueued--; });
  degradationQueue = task.catch(() => { degradationGapVersion++; });
  return task.then(() => completed);
}
function lostDegradationClaim(): void {
  healthBaselineVersion++;
  degradationGapVersion++;
  if (gapBarrier) return;
  // One bounded reconciliation, independent of the normal queue limit. The
  // gateway never holds rejected requests open waiting for database work.
  gapBarrier = degradationTask('gap', async () => {
    if (controlledOrigin && optional.canaryDegradation.state !== 'NOT_INSTALLED')
      await degradationState(pool,activeProject,new URL(controlledOrigin).hostname,controlledOrigin);
  }, true).finally(() => { gapBarrier = undefined; });
  void gapBarrier.catch(() => {});
}
function recordClaim(origin: string, source: 'core' | 'fallback') {
  if (origin !== normalizedOrigin || claimPending.has(source) || Date.now() < (claimAfter.get(source) ?? 0)) return;
  claimPending.add(source);
  // Bound writes for installed, explicitly enabled projects. Missing schemas are skipped by the gate.
  claimAfter.set(source,Date.now()+60_000);
  void optional.installation.run('claim', () => recordInstallationClaim(pool,activeProject,origin,source)).finally(()=>claimPending.delete(source));
}
const handleCheckout = checkoutWebhook(pool,activeProject,project ? process.env : {...process.env,CHECKOUT_WEBHOOK_SECRET:undefined});
const handleProjectCheckout = projectCheckoutWebhooks(pool,process.env);
const server = http.createServer((req, res) => {
  if (!boundary(req, res)) return;
  if (handleProjectCheckout(req,res)) return;
  if (scoped(req,res)) return;
  if (!project && req.url !== '/healthz') { res.writeHead(404).end(); return; }
  if (handleCheckout(req,res)) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/healthz') {
    void pool.query('SELECT 1').then(() => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({status:'ready', mode:mode.pilot ? 'PILOT_OBSERVE' : 'LAB', action:'OBSERVE_ONLY'}))).catch(() => res.writeHead(503).end()); return;
  }
  if (req.method === 'GET' && (req.url === '/runtime.js' || req.url === '/core.js' || req.url === '/fallback.js' || req.url === '/cta-inventory.js')) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(req.url === '/runtime.js' ? bootstrap : req.url === '/core.js' ? core : req.url === '/cta-inventory.js' ? inventoryScript : fallback); return;
  }
  if (req.method === 'GET' && (req.url === '/canary/html.gif' || req.url === '/canary/css.gif')) {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
    if (++count > 60 && process.env.GATEWAY_TRANSPORT !== 'HTTPS_PROXY') { lostDegradationClaim(); res.writeHead(429).end(); return; }
    const source = req.url === '/canary/html.gif' ? 'html_canary' : 'css_canary';
    void observeCanary(pool, activeProject, req.headers.referer, source).then(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
      // Referer is an unauthenticated claim. Only the explicitly configured
      // laboratory origin can contribute to the existing F44 journal.
      let claimedOrigin: string | undefined;
      try {
        if (req.headers.referer) {
          hostFromUrl(req.headers.referer);
          claimedOrigin = configuredOrigin(new URL(req.headers.referer).origin);
        }
      } catch { /* Missing or ambiguous claims never contribute. */ }
      if (claimedOrigin === normalizedOrigin && !activityPending && Date.now() >= activityAfter) {
        activityPending=true; activityAfter=Date.now()+60_000;
        void optional.health.run('activity', () => recordInstallationActivity(pool,activeProject,normalizedOrigin)).finally(()=>{activityPending=false;});
      }
      if (!mode.pilot && controlledOrigin && controlledOrigin !== normalizedOrigin && claimedOrigin === controlledOrigin) {
        if (optional.canaryDegradation.state !== 'NOT_INSTALLED') void degradationTask('correlation', async () => {
          const host = new URL(controlledOrigin).hostname;
          await recordDegradationClaim(pool,activeProject,host,source,controlledOrigin);
          await degradationState(pool,activeProject,host,controlledOrigin);
        });
      }
    }).catch(() => { lostDegradationClaim(); res.writeHead(503).end(); }); return;
  }
  if (req.method === 'POST' && (req.url === '/entry-decision' || req.url === '/cta-refresh')) {
    const refresh = req.url === '/cta-refresh';
    let origin: string;
    try { origin = configuredOrigin(req.headers.origin ?? ''); } catch { res.writeHead(400).end(); return; }
    if (refresh) {
      if (Date.now() - refreshWindowStart >= 60_000) { refreshWindowStart = Date.now(); refreshCount = 0; }
      if (++refreshCount > 60 && process.env.GATEWAY_TRANSPORT !== 'HTTPS_PROXY') { res.writeHead(429).end(); return; }
    } else {
      if (Date.now() - decisionWindowStart >= 60_000) { decisionWindowStart = Date.now(); decisionCount = 0; }
      if (++decisionCount > 60 && process.env.GATEWAY_TRANSPORT !== 'HTTPS_PROXY') { res.writeHead(429).end(); return; }
    }
    if (!/^text\/plain(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return; }
    let body = ''; let rejected = false; let bodyBytes = 0;
    req.on('data', (chunk: Buffer) => { if (rejected) return; bodyBytes += chunk.length; body += chunk.toString('utf8'); if (bodyBytes > 2048) { rejected = true; body = ''; res.writeHead(413).end(); } });
    req.on('end', () => {
    if (rejected) return;
    let session: unknown; let trafficClass: string; let evidence: RiskEvidence; let pathname: string|undefined;
    try { const input: unknown = JSON.parse(body); if (!input || typeof input !== 'object' || Array.isArray(input) || !['session,signals','pathname,session,signals'].includes(Object.keys(input).sort().join(','))) throw Error('invalid'); const fields = input as Record<string, unknown>; if (fields.pathname !== undefined && (typeof fields.pathname !== 'string' || !/^\/[a-zA-Z0-9/_-]{0,200}$/.test(fields.pathname))) throw Error('invalid pathname'); pathname=fields.pathname as string|undefined; session = fields.session; const traffic = classifyTraffic(fields.signals, origin); trafficClass = traffic.trafficClass; evidence = {source:'browser',reliability:'uncorroborated',trafficClass,kind:traffic.evidence}; } catch { res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({action:'OBSERVE_ONLY'})); return; }
    void (async () => {
      const gate=await pool.connect();
      try {
      await gate.query('BEGIN');
      if (!await legacyOperationallyEligible(gate,activeProject)) return {action:'OBSERVE_ONLY'};
      const controlled = controlledOrigin === origin && origin !== normalizedOrigin;
      const assessment = safeEvaluateRisk(controlled && process.env.LAB_CONTROLLED_RISK === 'LOW', fixture => {
        // Test-only negative fixtures can only suppress mitigation.
        if (controlled && process.env.LAB_CONTROLLED_RISK === 'ERROR') throw Error('controlled evaluator failure');
        const result = assessObservation(evidence, fixture);
        return controlled && process.env.LAB_CONTROLLED_RISK === 'HIGH' ? {...assessObservation(evidence,true),level:'HIGH'} : result;
      });
      if (!assessment) return {action:'OBSERVE_ONLY'};
      await recordRisk(pool, activeProject, new URL(origin).hostname, assessment, evidence);
      if (!stealthEligible(assessment, mode.pilot)) return {action:'OBSERVE_ONLY'};
      // Entry selection has no authority over a later interaction.
      if (refresh) return await ctaDecision(pool, activeProject, normalizedOrigin, origin, controlledOrigin, assessment.level, session, trafficClass, pathname);
      const result = await pool.query('SELECT v.version,v.enabled,v.approved_destination,v.allocation FROM active_protection_policies a JOIN protection_policy_versions v ON v.project_id=a.project_id AND v.version=a.version WHERE a.project_id=$1 AND v.stealth=true', [activeProject]);
      const entryPolicy = result.rows[0];
      // Invalid enabled entry policy is an evaluation failure, not permission to continue.
      if (entryPolicy && entryPolicy.enabled) {
        if (!Number.isSafeInteger(entryPolicy.version) || entryPolicy.version < 1) throw Error('invalid entry version');
        approvedDestination(entryPolicy.approved_destination, normalizedOrigin);
        validateAllocation(entryPolicy.allocation);
      }
      const entry = entryDecision(entryPolicy, normalizedOrigin, origin, controlledOrigin, assessment.level, session, trafficClass);
      if (entry.action === 'PAGE_REDIRECT') return entry;
      return await ctaDecision(pool, activeProject, normalizedOrigin, origin, controlledOrigin, assessment.level, session, trafficClass, pathname);
      } finally { try { await gate.query('ROLLBACK'); gate.release(); } catch { gate.release(true); } }
    })().then(decision => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(decision)))
      .catch(() => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({action:'OBSERVE_ONLY'}))); }); return;
  }
  if (req.method !== 'POST' || req.url !== '/observe' && req.url !== '/observe/fallback') { res.writeHead(404).end(); return; }
  if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
  if (++count > 60 && process.env.GATEWAY_TRANSPORT !== 'HTTPS_PROXY') { lostDegradationClaim(); res.writeHead(429).end(); return; }
  if (!/^text\/plain(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return; }
  let length = 0; const chunks: Buffer[] = []; let rejected = false;
  req.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length > 2048) { if (!rejected) { rejected = true; res.writeHead(413).end(); } chunks.length = 0; }
    else if (!rejected) chunks.push(chunk);
  });
  req.on('end', () => {
    if (rejected) return;
    const body = Buffer.concat(chunks).toString('utf8');
    let origin: string; let evidence: unknown;
    try {
      if (body.startsWith('{')) {
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload');
        const record = parsed as Record<string, unknown>;
        if (Object.keys(record).sort().join(',') !== 'origin,signals' || typeof record.origin !== 'string' || req.url !== '/observe') throw new Error('invalid payload');
        origin = configuredOrigin(record.origin); classifyTraffic(record.signals, origin); evidence = record.signals;
      } else origin = configuredOrigin(body);
      if (!req.headers.origin || origin !== configuredOrigin(req.headers.origin)) throw new Error('origin mismatch');
    }
    catch { res.writeHead(400).end(); return; }
    const source = req.url === '/observe/fallback' ? 'fallback' : 'core';
    void observe(pool, activeProject, mode.origins, origin, source, evidence).then(result => {
      if (result === 'authorized') recordClaim(origin,source);
      if (!mode.pilot && controlledOrigin && origin === controlledOrigin && origin !== normalizedOrigin) {
        void degradationTask('correlation', async () => {
          const temporalOrigin = optional.canaryDegradation.state === 'NOT_INSTALLED' ? undefined : origin;
          await recordDegradationClaim(pool,activeProject,new URL(origin).hostname,source,temporalOrigin);
          await degradationState(pool,activeProject,new URL(origin).hostname,temporalOrigin);
        });
      }
      res.writeHead(result === 'capacity' ? 429 : 204).end();
    }).catch(() => { lostDegradationClaim(); res.writeHead(503).end(); });
  });
});
server.requestTimeout = 5000; server.headersTimeout = 6000;
server.maxHeadersCount = 40;
server.setTimeout(10_000, socket => socket.destroy());
server.listen(port, '127.0.0.1');
let busy = false;
let installationCleanupAfter = 0;
let healthCleanupAfter = 0;
async function reconcileMaintenanceFailure() {
  await failures.reconcile(async pending => {
    if (pending.key) await reconcileOperationalEpisode(pool,activeProject,pending.source,pending.key,pending.openedAt,pending.recoveredAt,pending.safeCode);
    else await recoverOperationalSource(pool,activeProject,pending.source,pending.openedAt);
  });
}
async function maintenance() {
  if (busy) return;
  busy = true;
  try {
    const temporalOrigin = !mode.pilot && optional.canaryDegradation.state !== 'NOT_INSTALLED' ? controlledOrigin : undefined;
    await degradationTask('maintenance', () => maintainDegradation(pool, activeProject, temporalOrigin, optional.canaryDegradation.state !== 'NOT_INSTALLED'));
    try {
      await cleanup(pool, activeProject); await deliverOne(pool, activeProject, cloneSmtp ?? smtpPort);
      observeFailure('maintenance',false);
    } catch (error) {
      const code=(error as {code?:unknown} | null)?.code;
      const safeCode=typeof code==='string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
      observeFailure('maintenance',true,safeCode);
      process.stderr.write('maintenance MAINTENANCE_ERROR; persistence pending\n');
    }
    await optional.health.run('maintenance', async () => {
      if (healthBaselineVersion !== healthBaselinePersisted) {
        const version=healthBaselineVersion;
        await invalidateInactivity(pool,activeProject,version > 1);
        healthBaselinePersisted = version;
      }
      await reconcileMaintenanceFailure();
      const version=healthBaselineVersion;
      if (version === healthBaselinePersisted && claimPending.size === 0)
        await evaluateInactivity(pool, activeProject, () => version===healthBaselineVersion && claimPending.size===0);
      if (!cloneSmtp && version === healthBaselineVersion && version === healthBaselinePersisted) await deliverHealth(pool, activeProject, smtpPort, () => version===healthBaselineVersion);
      if (Date.now() >= healthCleanupAfter) {
        await maintainHealthHistory(pool, activeProject);
        healthCleanupAfter = Date.now() + 60 * 60_000;
      }
    });
    if (Date.now() >= installationCleanupAfter) {
      const completed = await optional.installation.run('retention', () => pool.query("DELETE FROM installation_signals WHERE project_id=$1 AND last_observed_at < now()-interval '7 days'", [activeProject]));
      if (completed) installationCleanupAfter = Date.now() + 60 * 60_000;
    }
  }
  catch (error) {
    const code=(error as {code?:unknown} | null)?.code;
    const safeCode=typeof code==='string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
    observeFailure('maintenance',true,safeCode);
    process.stderr.write('maintenance MAINTENANCE_ERROR; persistence pending\n');
  }
  finally { busy = false; }
}
async function infrastructureMaintenance() {
  if (dnsBusy) return;
  dnsBusy = true;
  try {
    const installed = await pool.query("SELECT to_regclass('infrastructure_dns_observations') IS NOT NULL AS installed");
    if (!installed.rows[0].installed) return;
    if (Date.now() >= dnsRetentionAfter) {
      await pool.query("DELETE FROM infrastructure_dns_observations WHERE project_id=$1 AND observed_at<now()-interval '30 days'",[activeProject]);
      dnsRetentionAfter=Date.now()+3600_000;
    }
    if (dnsResolver) {
      const host = dnsHosts[dnsIndex++ % dnsHosts.length];
      await collectInfrastructure(pool,activeProject,host,dnsHosts,dnsResolver,`configured-dns:${process.env.INFRASTRUCTURE_DNS_SERVER}`);
    }
  } catch { process.stderr.write('infrastructure DNS maintenance failed\n'); }
  finally { dnsBusy = false; }
}
if (project) void infrastructureMaintenance();
const dnsTimer = setInterval(() => { if (project) void infrastructureMaintenance(); },60_000);
dnsTimer.unref();
if (project) void maintenance();
void maintainProjects();
const timer = setInterval(() => { if (project) void maintenance(); void maintainProjects(); }, 1000);
process.on('SIGTERM', () => { clearInterval(timer); clearInterval(dnsTimer); server.close(() => { void pool.end().finally(() => process.exit()); }); });
