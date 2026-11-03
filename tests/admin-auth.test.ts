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
  assert.throws(() => createAdminServer(''));
  const server = createAdminServer(record, () => clock).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password: string) => fetch(`${base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const check = (token: string) => fetch(`${base}/admin/session`, { headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await check('bad')).status, 401);
    assert.equal((await login('wrong')).status, 401);
    const first = await login('test password'); assert.equal(first.status, 200); const { token } = await first.json() as { token: string };
    assert.equal((await check(token)).status, 200);
    assert.equal((await fetch(`${base}/admin/session`, { headers: { authorization: `Bearer ${token}`, origin: 'http://evil.test' } })).status, 403);
    const second = await login('test password'); const token2 = (await second.json() as { token: string }).token;
    assert.equal((await check(token)).status, 401);
    clock += 900000; assert.equal((await check(token2)).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('test password')).status, 429);
  } finally { server.close(); await once(server, 'close'); }
});
