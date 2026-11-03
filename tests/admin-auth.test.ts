import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { createAdminServer } from '../apps/admin-auth.js';

test('laboratory login, denial, expiration, replacement and rate limit', async () => {
  let clock = 1000000;
  const salt = '0123456789abcdef0123456789abcdef';
  const record = `scrypt$${salt}$${scryptSync('test password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
  await db.query('DELETE FROM admin_totp_replay');
  await db.query('DELETE FROM admin_totp_codes');
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const totp = new TOTP({ secret: Secret.fromBase32(secret) });
  const code = (timestamp = clock) => totp.generate({ timestamp });
  assert.throws(() => createAdminServer('', secret, db));
  const server = createAdminServer(record, secret, db, () => clock).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password: string, token = code()) => fetch(`${base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, code: token }) });
  const check = (token: string) => fetch(`${base}/admin/session`, { headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await check('bad')).status, 401);
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('test password', 'invalid')).status, 401);
    assert.equal((await login('test password', code(clock - 90000))).status, 401);
    const first = await login('test password'); assert.equal(first.status, 200); const { token } = await first.json() as { token: string };
    assert.equal((await check(token)).status, 200);
    assert.equal((await fetch(`${base}/admin/session`, { headers: { authorization: `Bearer ${token}`, origin: 'http://evil.test' } })).status, 403);
    assert.equal((await login('test password')).status, 401);
    clock += 60000;
    const second = await login('test password'); const token2 = (await second.json() as { token: string }).token;
    assert.equal((await check(token)).status, 401);
    clock += 900000; assert.equal((await check(token2)).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('test password')).status, 429);
  } finally { server.close(); await once(server, 'close'); await db.end(); }
});
