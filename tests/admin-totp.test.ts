import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';

test('TOTP replay is rejected concurrently and after restart', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
  await db.query('DELETE FROM admin_totp_replay');
  await db.query('DELETE FROM admin_totp_codes');
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', clock = 3000000;
  const salt = '0123456789abcdef0123456789abcdef';
  const record = `scrypt$${salt}$${scryptSync('password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  const token = new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: clock });
  const start = async () => { const server = createAdminServer(record, secret, db, () => clock).listen(0, '127.0.0.1'); await once(server, 'listening'); return server; };
  const login = (port: number) => fetch(`http://127.0.0.1:${port}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password', code: token }) });
  let server = await start();
  try {
    const port = (server.address() as AddressInfo).port;
    const results = await Promise.all([login(port), login(port)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    server.close(); await once(server, 'close');
    server = await start();
    assert.equal((await login((server.address() as AddressInfo).port)).status, 401);
  } finally { server.close(); await once(server, 'close'); await db.end(); }
});


test('the same six digits cannot be reused when adjacent counters collide', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
  await db.query('DELETE FROM admin_totp_replay'); await db.query('DELETE FROM admin_totp_codes');
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', salt = '0123456789abcdef0123456789abcdef';
  const record = `scrypt$${salt}$${scryptSync('password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  let clock = 910737 * 30000;
  const generator = new TOTP({ secret: Secret.fromBase32(secret) });
  const code = generator.generate({ timestamp: clock });
  assert.equal(code, generator.generate({ timestamp: clock + 30000 }));
  const server = createAdminServer(record, secret, db, () => clock).listen(0, '127.0.0.1'); await once(server, 'listening');
  const login = () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password', code }) });
  try { assert.equal((await login()).status, 200); clock += 30000; assert.equal((await login()).status, 401); }
  finally { server.close(); await once(server, 'close'); await db.end(); }
});
