import { TOTP, Secret } from 'otpauth';
import { Pool } from 'pg';
import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { configuredOrigin } from './detection.js';

// Laboratory-only: one process, one owner, ephemeral sessions and rate limit.
export function createAdminServer(passwordRecord: string, totpSecret: string, db: Pool, now: () => number = Date.now) {
  if (!/^[A-Z2-7]{32}$/.test(totpSecret)) throw new Error('invalid TOTP configuration');
  const totp = new TOTP({ secret: Secret.fromBase32(totpSecret), algorithm: 'SHA1', digits: 6, period: 30 });
  const factorId = createHash('sha256').update(totpSecret).digest('hex');
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
    if (req.url?.startsWith('/admin/') && req.url !== '/admin/login') {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const key = token && createHash('sha256').update(token).digest('hex');
      const expiry = key && sessions.get(key);
      if (!key || !expiry || now() >= expiry) { if (key) sessions.delete(key); res.writeHead(401).end(); return; }
      if (req.method === 'GET' && req.url === '/admin/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"authenticated":true}'); return;
      }
      if (req.method === 'GET' && req.url === '/admin/projects') {
        void db.query('SELECT id, name, origin FROM projects ORDER BY name, id').then(result => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.rows))).catch(() => res.writeHead(503).end()); return;
      }
      const projectPath = /^\/admin\/projects\/([a-zA-Z0-9_-]{1,64})\/(observations|incidents)$/.exec(req.url ?? '');
      if (req.method === 'GET' && projectPath) {
        const table = projectPath[2] === 'observations' ? 'observations' : 'incidents';
        void db.query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY id LIMIT 100`, [projectPath[1]]).then(result => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.rows))).catch(() => res.writeHead(503).end()); return;
      }
      if (req.method === 'POST' && req.url === '/admin/projects') {
        if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
        let size = 0, rejected = false; const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) { if (!rejected) res.writeHead(413).end(); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(chunk); });
        req.on('end', () => {
          if (rejected) return;
          let name: string, origin: string;
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body !== 'object' || !('name' in body) || !('origin' in body) || typeof body.name !== 'string' || typeof body.origin !== 'string' || !body.name.trim() || body.name.length > 100) throw Error('invalid');
            name = body.name.trim(); origin = configuredOrigin(body.origin);
          } catch { res.writeHead(400).end(); return; }
          void db.query('INSERT INTO projects(id,name,origin) VALUES($1,$2,$3) RETURNING id,name,origin', [randomUUID(), name, origin]).then(result => res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.rows[0]))).catch((error: {code?: string}) => res.writeHead(error.code === '23505' ? 409 : 503).end());
        }); return;
      }
      res.writeHead(404).end(); return;
    }
    if (req.method !== 'POST' || req.url !== '/admin/login') { res.writeHead(404).end(); return; }
    if (now() - windowStart >= 60_000) { attempts = 0; windowStart = now(); }
    if (++attempts > 5 || pending) { res.writeHead(429).end(); return; }
    if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
    let size = 0, rejected = false; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024) { if (!rejected) res.writeHead(413).end(); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(chunk); });
    req.on('end', async () => {
      if (rejected) return;
      let password: unknown, code: unknown;
      try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof body === 'object' && body !== null) { if ('password' in body) password = body.password; if ('code' in body) code = body.code; } } catch { /* generic failure */ }
      if (typeof password !== 'string' || Buffer.byteLength(password) > 512) { res.writeHead(401).end(); return; }
      pending = true;
      let actual: Buffer;
      try { actual = scryptSync(password, salt, 64); } finally { pending = false; }
      if (!timingSafeEqual(actual, expected) || typeof code !== 'string' || !/^\d{6}$/.test(code)) { res.writeHead(401).end(); return; }
      const timestamp = now();
      const delta = totp.validate({ token: code, timestamp, window: 1 });
      if (delta === null) { res.writeHead(401).end(); return; }
      const counter = Math.floor(timestamp / 30000) + delta;
      const digest = createHmac('sha256', Buffer.from(totpSecret)).update(code).digest('hex');
      let client;
      try {
        client = await db.connect();
        await client.query('BEGIN');
        const result = await client.query(`INSERT INTO admin_totp_replay (factor_id, last_counter) VALUES ($1, $2)
          ON CONFLICT (factor_id) DO UPDATE SET last_counter = EXCLUDED.last_counter
          WHERE admin_totp_replay.last_counter < EXCLUDED.last_counter RETURNING last_counter`, [factorId, counter]);
        if (!result.rowCount) { await client.query('ROLLBACK'); res.writeHead(401).end(); return; }
        const currentCounter = Math.floor(timestamp / 30000);
        await client.query('DELETE FROM admin_totp_codes WHERE factor_id = $1 AND valid_until < $2', [factorId, currentCounter]);
        const used = await client.query(`INSERT INTO admin_totp_codes (factor_id, digest, valid_until) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING RETURNING digest`, [factorId, digest, currentCounter + 2]);
        if (!used.rowCount) { await client.query('ROLLBACK'); res.writeHead(401).end(); return; }
        await client.query('COMMIT');
      } catch { if (client) { try { await client.query('ROLLBACK'); } catch { /* fail closed */ } } res.writeHead(503).end(); return; }
      finally { client?.release(); }
      const token = randomBytes(32).toString('hex');
      // Only one active session; replacing it bounds storage and revokes previous tokens.
      sessions.clear(); sessions.set(createHash('sha256').update(token).digest('hex'), now() + 15 * 60_000);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, expiresIn: 900 }));
    });
  });
}
