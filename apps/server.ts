import http from 'node:http';
import { Pool } from 'pg';
import { configuredOrigin, cleanup, observe } from './detection.js';
import { deliverOne } from './alerts.js';
const connectionString = process.env.DATABASE_URL, allowedOrigin = process.env.ALLOWED_ORIGIN, project = process.env.PROJECT_ID;
const smtpPort = Number(process.env.SMTP_PORT), port = Number(process.env.PORT ?? 3000);
if (!connectionString || !allowedOrigin || !project || !/^[a-zA-Z0-9_-]{1,64}$/.test(project) || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid local test configuration');
const activeProject: string = project;
const normalizedOrigin = configuredOrigin(allowedOrigin), pool = new Pool({ connectionString });
let windowStart = Date.now(), count = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/runtime.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(`fetch('http://127.0.0.1:${port}/observe',{method:'POST',headers:{'Content-Type':'text/plain'},body:location.origin,keepalive:true}).catch(()=>{});`); return;
  }
  if (req.method !== 'POST' || req.url !== '/observe') { res.writeHead(404).end(); return; }
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
    try { origin = configuredOrigin(body); if (origin !== req.headers.origin) throw new Error('origin mismatch'); }
    catch { res.writeHead(400).end(); return; }
    void observe(pool, activeProject, normalizedOrigin, origin).then(result => res.writeHead(result === 'capacity' ? 429 : 204).end()).catch(() => res.writeHead(503).end());
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
