import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { AddressInfo,connect } from 'node:net';
import {request} from 'node:http';
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
    const hostile:Record<string,string>[]=[{host:'evil.test'},{forwarded:'for=127.0.0.1'},{'x-forwarded-for':'127.0.0.1'},{'x-forwarded-host':'127.0.0.1'},{'x-forwarded-proto':'https'},{'x-real-ip':'127.0.0.1'}];
    for(const headers of hostile){
      const status=await new Promise<number|undefined>((resolve,reject)=>{
        const req=request(`${base}/admin/session`,{headers:{authorization:`Bearer ${token}`,...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
      });
      assert.equal(status,403,JSON.stringify(headers));
    }
    assert.equal((await check(token)).status,200,'rejected proxy/rebinding claims do not revoke the real private session');
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

test('private admin bounds headers and incomplete login bodies on real sockets',{timeout:25000},async()=>{
  const salt='0123456789abcdef0123456789abcdef';
  const record=`scrypt$${salt}$${scryptSync('test password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const db=new Pool(); // No database operation occurs before a complete valid login.
  const server=createAdminServer(record,'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',db).listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  try {
    const large=await new Promise<number|undefined>((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port,path:'/admin/login',headers:{'x-padding':'x'.repeat(9000)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
    });
    assert.equal(large,431);
    const start=Date.now();
    const response=await new Promise<string>((resolve,reject)=>{
      const socket=connect(port,'127.0.0.1',()=>socket.write(`POST /admin/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`));
      let received='';socket.on('data',chunk=>{received+=chunk.toString();});socket.on('error',reject);socket.on('close',()=>resolve(received));
    });
    assert.match(response,/HTTP\/1.1 408/);
    assert.ok(Date.now()-start<20000,'incomplete body released within the private request budget');
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/session`)).status,401,'listener remains available');
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.end();}
});
