import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// Laboratory-only: one process, one owner, ephemeral sessions and rate limit.
export function createAdminServer(passwordRecord: string, now: () => number = Date.now) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(passwordRecord);
  if (!match) throw new Error('invalid administrator credential record');
  const salt = Buffer.from(match[1], 'hex'), expected = Buffer.from(match[2], 'hex');
  const sessions = new Map<string, number>();
  let attempts = 0, windowStart = now(), pending = false;
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // No CORS and no browser-origin requests: this slice is a local API, not a UI.
    if (req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/admin/session') {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const key = token && createHash('sha256').update(token).digest('hex');
      const expiry = key && sessions.get(key);
      if (!key || !expiry || now() >= expiry) { if (key) sessions.delete(key); res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"authenticated":true}'); return;
    }
    if (req.method !== 'POST' || req.url !== '/admin/login') { res.writeHead(404).end(); return; }
    if (now() - windowStart >= 60_000) { attempts = 0; windowStart = now(); }
    if (++attempts > 5 || pending) { res.writeHead(429).end(); return; }
    if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
    let size = 0, rejected = false; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024) { if (!rejected) res.writeHead(413).end(); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(chunk); });
    req.on('end', () => {
      if (rejected) return;
      let password: unknown;
      try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof body === 'object' && body !== null && 'password' in body) password = body.password; } catch { /* generic failure */ }
      if (typeof password !== 'string' || Buffer.byteLength(password) > 512) { res.writeHead(401).end(); return; }
      pending = true;
      let actual: Buffer;
      try { actual = scryptSync(password, salt, 64); } finally { pending = false; }
      if (!timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
      const token = randomBytes(32).toString('hex');
      // Only one active session; replacing it bounds storage and revokes previous tokens.
      sessions.clear(); sessions.set(createHash('sha256').update(token).digest('hex'), now() + 15 * 60_000);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, expiresIn: 900 }));
    });
  });
}
