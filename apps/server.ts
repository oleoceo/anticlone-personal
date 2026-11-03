import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { configuredOrigin, cleanup, observe, observeCanary } from './detection.js';
import { deliverOne } from './alerts.js';
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
const projectRow = await pool.query('SELECT origin FROM projects WHERE id=$1', [activeProject]);
if (projectRow.rowCount !== 1) throw new Error('unknown project');
const normalizedOrigin = configuredOrigin(projectRow.rows[0].origin);
if (legacyOrigin && legacyOrigin !== normalizedOrigin) throw new Error('legacy configuration conflicts with project');
const bootstrap = readFileSync('runtime/bootstrap.js');
const core = readFileSync('runtime/core.js');
const fallback = readFileSync('runtime/fallback.js');
let windowStart = Date.now(), count = 0;
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
    let origin: string;
    try { origin = configuredOrigin(body); if (!req.headers.origin || origin !== configuredOrigin(req.headers.origin)) throw new Error('origin mismatch'); }
    catch { res.writeHead(400).end(); return; }
    void observe(pool, activeProject, normalizedOrigin, origin, req.url === '/observe/fallback' ? 'fallback' : 'core').then(result => res.writeHead(result === 'capacity' ? 429 : 204).end()).catch(() => res.writeHead(503).end());
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
