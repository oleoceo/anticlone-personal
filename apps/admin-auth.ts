import { TOTP, Secret } from 'otpauth';
import { Pool } from 'pg';
import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { configuredOrigin } from './detection.js';
import { activatePolicy, saveDraft } from './protection-policy.js';
import { importInventory, approveDestination, mapPoint, reviewPoint } from './cta-inventory.js';
import { publishCtaPolicy } from './cta-policy.js';
import { Conflict, getNotificationSettings, saveNotificationSettings, setNotificationPreference } from './notification-settings.js';
import { handleAdminUi } from './admin-ui.js';

// Laboratory-only: one process, one owner, ephemeral sessions and rate limit.
export function createAdminServer(passwordRecord: string, totpSecret: string, db: Pool, now: () => number = Date.now) {
  if (!/^[A-Z2-7]{32}$/.test(totpSecret)) throw new Error('invalid TOTP configuration');
  const totp = new TOTP({ secret: Secret.fromBase32(totpSecret), algorithm: 'SHA1', digits: 6, period: 30 });
  const factorId = createHash('sha256').update(totpSecret).digest('hex');
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(passwordRecord);
  if (!match) throw new Error('invalid administrator credential record');
  const salt = Buffer.from(match[1], 'hex'), expected = Buffer.from(match[2], 'hex');
  const sessions = new Map<string, { expiry: number; kind: 'bearer' | 'web'; csrf: string }>();
  let attempts = 0, windowStart = now(), pending = false;
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const uiLogin = req.url === '/admin/ui/login' && req.method === 'POST';
    if (req.url?.startsWith('/admin/ui/')) {
      if (!handleAdminUi(req, res, db, sessions, now, uiLogin)) return;
    } else {
      // Preserve the existing bearer API browser-origin boundary.
      if (req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403).end(); return; }
    }
    if (!uiLogin && req.url?.startsWith('/admin/') && req.url !== '/admin/login') {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const key = token && createHash('sha256').update(token).digest('hex');
      const session = key && sessions.get(key);
      if (!key || !session || session.kind !== 'bearer' || now() >= session.expiry) { if (key && session && now() >= session.expiry) sessions.delete(key); res.writeHead(401).end(); return; }
      if (req.url === '/admin/notification-settings' && req.method === 'GET') {
        void getNotificationSettings(db).then(result=>res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result))).catch(()=>res.writeHead(503).end()); return;
      }
      if (req.method === 'POST' && (req.url === '/admin/notification-settings' || req.url === '/admin/notification-settings/preference')) {
        if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
        let size=0, rejected=false; const chunks: Buffer[]=[];
        req.on('data',(chunk:Buffer)=>{ size+=chunk.length; if(size>4096) { if(!rejected) res.writeHead(413).end(); rejected=true; chunks.length=0; } else if(!rejected) chunks.push(chunk); });
        req.on('end',()=>{
          if(rejected) return;
          let body:unknown; try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
          const operation=req.url === '/admin/notification-settings' ? saveNotificationSettings(db,body) : setNotificationPreference(db,body);
          void operation.then(result=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error:unknown)=>res.writeHead(error instanceof Conflict ? 409 : error instanceof TypeError ? 400 : 503).end());
        }); return;
      }
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
      const alertPath = /^\/admin\/projects\/([a-zA-Z0-9_-]{1,64})\/cta\/alerts$/.exec(req.url ?? '');
      if (req.method === 'GET' && alertPath) {
        void db.query('SELECT id,point_id,reason,created_at FROM cta_drift_alerts WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[alertPath[1]])
          .then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result.rows))).catch(() => res.writeHead(503).end()); return;
      }
      const ctaPath = /^\/admin\/projects\/([a-zA-Z0-9_-]{1,64})\/cta(?:\/(inventory|destinations|mappings|policy|review))?$/.exec(req.url ?? '');
      if (ctaPath && req.method === 'GET' && !ctaPath[2]) {
        void db.query(`SELECT p.id,p.surface,p.marker,p.kind,p.offer,p.review_required,o.id AS observation_id,o.evidence,o.confidence,o.observed_url,o.observed_at,m.destination_id,d.url AS approved_url,
          COALESCE(s.suggestions,ARRAY[]::uuid[]) AS structural_candidates
          FROM cta_points p LEFT JOIN LATERAL (SELECT id,evidence,confidence,observed_url,observed_at FROM cta_observations WHERE project_id=p.project_id AND point_id=p.id AND observed_at >= now()-interval '7 days' ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
          LEFT JOIN cta_mappings m ON m.project_id=p.project_id AND m.point_id=p.id
          LEFT JOIN cta_destinations d ON d.project_id=m.project_id AND d.offer=m.offer AND d.id=m.destination_id
          LEFT JOIN LATERAL (SELECT array_agg(DISTINCT other.id) AS suggestions FROM cta_points other JOIN cta_observations evidence ON evidence.project_id=other.project_id AND evidence.point_id=other.id
            WHERE o.confidence='LOW' AND other.project_id=p.project_id AND other.surface=p.surface AND other.id<>p.id AND other.kind=p.kind
              AND evidence.observed_at>=now()-interval '7 days' AND evidence.observed_url=o.observed_url
              AND split_part(evidence.evidence,':ordinal:',1)=split_part(o.evidence,':ordinal:',1)) s ON true
          WHERE p.project_id=$1 AND (o.observed_at IS NOT NULL OR m.point_id IS NOT NULL) ORDER BY p.id LIMIT 1000`,[ctaPath[1]])
          .then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result.rows))).catch(() => res.writeHead(503).end()); return;
      }
      if (ctaPath && req.method === 'GET' && ctaPath[2] === 'destinations') {
        void db.query('SELECT id,offer,url FROM cta_destinations WHERE project_id=$1 ORDER BY offer,id LIMIT 1000',[ctaPath[1]])
          .then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result.rows))).catch(() => res.writeHead(503).end()); return;
      }
      if (ctaPath && req.method === 'POST' && ctaPath[2]) {
        if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
        let size = 0, rejected = false; const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 131072) { if (!rejected) res.writeHead(413).end(); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(chunk); });
        req.on('end', () => {
          if (rejected) return;
          let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
          const operation = ctaPath[2] === 'policy' ? publishCtaPolicy(db,ctaPath[1],body).then(version => ({version})) : ctaPath[2] === 'inventory' ? importInventory(db,ctaPath[1],body).then(() => ({})) : ctaPath[2] === 'destinations' ? approveDestination(db,ctaPath[1],body) : ctaPath[2] === 'review' ? reviewPoint(db,ctaPath[1],body).then(() => ({})) : mapPoint(db,ctaPath[1],body).then(() => ({}));
          void operation.then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error: Error & {code?: string}) => res.writeHead(error instanceof TypeError || !error.code ? 400 : 503).end());
        }); return;
      }
      const policyPath = /^\/admin\/projects\/([a-zA-Z0-9_-]{1,64})\/policy\/(draft|publish|activate)$/.exec(req.url ?? '');
      if (req.method === 'POST' && policyPath) {
        if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
        let size = 0, rejected = false; const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) { if (!rejected) res.writeHead(413).end(); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(chunk); });
        req.on('end', () => {
          if (rejected) return;
          let body: unknown;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
          if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400).end(); return; }
          const fields = body as Record<string, unknown>;
          if (policyPath[2] === 'publish' && Object.keys(fields).length || policyPath[2] === 'activate' && (Object.keys(fields).join(',') !== 'version' || typeof fields.version !== 'number')) { res.writeHead(400).end(); return; }
          const operation = policyPath[2] === 'draft' ? saveDraft(db,policyPath[1],body).then(() => ({})) : activatePolicy(db,policyPath[1],policyPath[2] === 'activate' ? fields.version as number : undefined).then(version => ({version}));
          void operation.then(result => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result))).catch((error: Error & {code?: string}) => res.writeHead(error.code ? 503 : 400).end());
        }); return;
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
    if (req.method !== 'POST' || (req.url !== '/admin/login' && !uiLogin)) { res.writeHead(404).end(); return; }
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
      sessions.clear(); sessions.set(createHash('sha256').update(token).digest('hex'), { expiry: now() + 15 * 60_000, kind: uiLogin ? 'web' : 'bearer', csrf: randomBytes(32).toString('hex') });
      if (uiLogin) { res.setHeader('Set-Cookie', [`admin_session=${token}; HttpOnly; SameSite=Strict; Path=/admin/ui/; Max-Age=900`, 'admin_login_csrf=; HttpOnly; SameSite=Strict; Path=/admin/ui/; Max-Age=0']); res.writeHead(204).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, expiresIn: 900 }));
    });
  });
}
