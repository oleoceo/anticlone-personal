import http from 'node:http';
import { Pool } from 'pg';
import { configuredOrigin, hostFromUrl, observe } from './detection.js';
const connectionString = process.env.DATABASE_URL, allowedOrigin = process.env.ALLOWED_ORIGIN, project = process.env.PROJECT_ID;
if (!connectionString || !allowedOrigin || !project || !/^[a-zA-Z0-9_-]{1,64}$/.test(project)) throw new Error('DATABASE_URL, ALLOWED_ORIGIN and PROJECT_ID required');
const normalizedOrigin = configuredOrigin(allowedOrigin), pool = new Pool({ connectionString });
let windowStart = Date.now(), count = 0;
// Local test prototype only. Browser location is an untrusted claim.
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/runtime.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end("fetch('http://127.0.0.1:3000/observe',{method:'POST',headers:{'Content-Type':'text/plain'},body:location.origin,keepalive:true}).catch(()=>{});"); return;
  }
  if (req.method !== 'POST' || req.url !== '/observe') { res.writeHead(404).end(); return; }
  if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
  if (++count > 60) { res.writeHead(429).end(); return; }
  let body = ''; req.setEncoding('utf8');
  req.on('data', (chunk: string) => { body += chunk; if (body.length > 2048) req.destroy(); });
  req.on('end', async () => {
    try { hostFromUrl(body); } catch { res.writeHead(400).end(); return; }
    try { await observe(pool, project, normalizedOrigin, body); res.writeHead(204).end(); } catch { res.writeHead(503).end(); }
  });
});
server.listen(3000, '127.0.0.1');
