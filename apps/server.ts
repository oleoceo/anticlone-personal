import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { configuredOrigin, cleanup, observe, observeCanary } from './detection.js';
import { deliverOne } from './alerts.js';
import { classifyTraffic } from './traffic.js';
import { entryDecision } from './page-redirect.js';
import { safeEvaluateRisk, recordRisk } from './risk.js';
const connectionString = process.env.DATABASE_URL, project = process.env.PROJECT_ID;
const smtpPort = Number(process.env.SMTP_PORT), port = Number(process.env.PORT ?? 3000);
if (!connectionString || !project || !/^[a-zA-Z0-9_-]{1,64}$/.test(project) || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid local test configuration');
const activeProject: string = project;
const pool = new Pool({ connectionString });
// One-time legacy import is driven solely by the local operator's old configuration.
const legacyOrigin = process.env.ALLOWED_ORIGIN && configuredOrigin(process.env.ALLOWED_ORIGIN);
if (legacyOrigin) {
  await pool.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2) ON CONFLICT (id) DO NOTHING', [activeProject, legacyOrigin]);
}
await pool.query('SELECT project_id, host, day, traffic_class, evidence, certainty, source, observed_at FROM traffic_observation_days LIMIT 0');
await pool.query('SELECT project_id,host,day,level,evaluator_version,source,reason,confidence,observed_at FROM risk_assessment_days LIMIT 0');
const projectRow = await pool.query('SELECT origin FROM projects WHERE id=$1', [activeProject]);
if (projectRow.rowCount !== 1) throw new Error('unknown project');
const normalizedOrigin = configuredOrigin(projectRow.rows[0].origin);
if (legacyOrigin && legacyOrigin !== normalizedOrigin) throw new Error('legacy configuration conflicts with project');
// The operator controls this local experiment; requests never provide risk.
const controlledOrigin = process.env.LAB_CONTROLLED_ORIGIN ? configuredOrigin(process.env.LAB_CONTROLLED_ORIGIN) : undefined;
if (controlledOrigin && (!['127.0.0.1', 'localhost'].includes(new URL(controlledOrigin).hostname) || !['127.0.0.1', 'localhost'].includes(new URL(normalizedOrigin).hostname))) throw new Error('lab origins must be loopback');
const bootstrap = readFileSync('runtime/bootstrap.js');
const core = readFileSync('runtime/core.js');
const fallback = readFileSync('runtime/fallback.js');
let windowStart = Date.now(), count = 0;
let decisionWindowStart = Date.now(), decisionCount = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && (req.url === '/runtime.js' || req.url === '/core.js' || req.url === '/fallback.js')) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(req.url === '/runtime.js' ? bootstrap : req.url === '/core.js' ? core : fallback); return;
  }
  if (req.method === 'GET' && (req.url === '/canary/html.gif' || req.url === '/canary/css.gif')) {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
    if (++count > 60) { res.writeHead(429).end(); return; }
    const source = req.url === '/canary/html.gif' ? 'html_canary' : 'css_canary';
    void observeCanary(pool, activeProject, req.headers.referer, source).then(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
    }).catch(() => res.writeHead(503).end()); return;
  }
  if (req.method === 'POST' && req.url === '/entry-decision') {
    let origin: string;
    try { origin = configuredOrigin(req.headers.origin ?? ''); } catch { res.writeHead(400).end(); return; }
    if (Date.now() - decisionWindowStart >= 60_000) { decisionWindowStart = Date.now(); decisionCount = 0; }
    if (++decisionCount > 60) { res.writeHead(429).end(); return; }
    if (!/^text\/plain(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(415).end(); return; }
    let body = ''; let rejected = false;
    req.on('data', (chunk: Buffer) => { if (rejected) return; body += chunk.toString('utf8'); if (body.length > 2048) { rejected = true; body = ''; res.writeHead(413).end(); } });
    req.on('end', () => {
    if (rejected) return;
    let session: unknown; let trafficClass: string;
    try { const input: unknown = JSON.parse(body); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'session,signals') throw Error('invalid'); const fields = input as Record<string, unknown>; session = fields.session; trafficClass = classifyTraffic(fields.signals, origin).trafficClass; } catch { res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({action:'OBSERVE_ONLY'})); return; }
    void (async () => {
      const assessment = safeEvaluateRisk(controlledOrigin === origin && origin !== normalizedOrigin && process.env.LAB_CONTROLLED_RISK === 'LOW');
      if (!assessment) return {action:'OBSERVE_ONLY'};
      await recordRisk(pool, activeProject, new URL(origin).hostname, assessment);
      const result = await pool.query('SELECT v.version,v.enabled,v.approved_destination,v.allocation FROM active_protection_policies a JOIN protection_policy_versions v ON v.project_id=a.project_id AND v.version=a.version WHERE a.project_id=$1 AND v.stealth=true', [activeProject]);
      return entryDecision(result.rows[0], normalizedOrigin, origin, controlledOrigin, assessment.level, session, trafficClass);
    })().then(decision => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(decision)))
      .catch(() => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({action:'OBSERVE_ONLY'}))); }); return;
  }
  if (req.method !== 'POST' || req.url !== '/observe' && req.url !== '/observe/fallback') { res.writeHead(404).end(); return; }
  if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
  if (++count > 60) { res.writeHead(429).end(); return; }
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
    void observe(pool, activeProject, normalizedOrigin, origin, req.url === '/observe/fallback' ? 'fallback' : 'core', evidence).then(result => res.writeHead(result === 'capacity' ? 429 : 204).end()).catch(() => res.writeHead(503).end());
  });
});
server.requestTimeout = 5000; server.headersTimeout = 6000;
server.listen(port, '127.0.0.1');
let busy = false;
async function maintenance() {
  if (busy) return;
  busy = true;
  try { await cleanup(pool, activeProject); await deliverOne(pool, activeProject, smtpPort); }
  catch { process.stderr.write('maintenance failed\n'); }
  finally { busy = false; }
}
void maintenance(); const timer = setInterval(() => void maintenance(), 1000);
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => { void pool.end().finally(() => process.exit()); }); });
