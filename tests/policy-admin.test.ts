import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';

test('policy publication and activation require the existing admin session', async () => {
  const db = new Pool({connectionString:process.env.TEST_DATABASE_URL});
  for (const file of ['001_initial','002_alerts','003_projects','007_protection_policy']) await db.query(await readFile(`infra/${file}.sql`,'utf8'));
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
  const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt='0123456789abcdef0123456789abcdef';
  const factor=createHash('sha256').update(secret).digest('hex');
  await db.query('DELETE FROM admin_totp_replay WHERE factor_id=$1',[factor]); await db.query('DELETE FROM admin_totp_codes WHERE factor_id=$1',[factor]);
  const record=`scrypt$${salt}$${scryptSync('password',Buffer.from(salt,'hex'),64).toString('hex')}`;
  const server=createAdminServer(record,secret,db).listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project=`authpolicy_${crypto.randomUUID()}`, origin=`http://localhost:${20000+Math.floor(Math.random()*20000)}`;
  await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)',[project,origin]);
  const path=`${base}/admin/projects/${project}/policy`;
  const post=(part:string,body:object,token?:string)=>fetch(`${path}/${part}`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  try {
    for (const part of ['draft','publish','activate']) assert.equal((await post(part,{})).status,401);
    const login=await fetch(`${base}/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'password',code:new TOTP({secret:Secret.fromBase32(secret)}).generate()})});
    assert.equal(login.status,200); const {token}=await login.json() as {token:string};
    assert.equal((await post('draft',{enabled:true,approved_destination:origin+'/ok',stealth:true},token)).status,200);
    assert.equal((await post('publish',{},token)).status,200);
    assert.equal((await post('activate',{version:1},token)).status,200);
    assert.equal((await post('activate',{version:999},token)).status,400);
  } finally { server.close(); await once(server,'close'); await db.end(); }
});
