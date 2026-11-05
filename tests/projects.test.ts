import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scryptSync, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { TOTP, Secret } from 'otpauth';
import { createAdminServer } from '../apps/admin-auth.js';

test('projects: authenticated creation, unique origins and isolated evidence', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query(await readFile('infra/008_traffic_observations.sql', 'utf8'));
  await db.query(await readFile('infra/009_risk_assessments.sql', 'utf8'));
  await db.query(await readFile('infra/024_risk_evidence.sql', 'utf8'));
  for (const path of ['infra/001_initial.sql', 'infra/002_alerts.sql', 'infra/003_projects.sql', 'infra/004_observation_sources.sql', 'infra/005_canaries.sql', 'infra/018_notification_budget.sql', 'infra/019_alert_outbox_expiry.sql']) await db.query(await readFile(path, 'utf8'));
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_replay (factor_id text PRIMARY KEY, last_counter bigint NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS admin_totp_codes (factor_id text NOT NULL, digest text NOT NULL, valid_until bigint NOT NULL, PRIMARY KEY (factor_id, digest))');
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', salt = '0123456789abcdef0123456789abcdef';
  const factor = createHash('sha256').update(secret).digest('hex');
  await db.query('DELETE FROM admin_totp_replay WHERE factor_id=$1', [factor]);
  await db.query('DELETE FROM admin_totp_codes WHERE factor_id=$1', [factor]);
  const record = `scrypt$${salt}$${scryptSync('password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  const server = createAdminServer(record, secret, db).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const suffix = randomUUID(), ids: string[] = [], legacy = `legacy_${suffix}`;
  const children: ChildProcess[] = [];
  try {
    assert.equal((await fetch(`${base}/admin/projects`)).status, 401);
    assert.equal((await fetch(`${base}/admin/projects/example/risk-assessments`)).status, 401);
    const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({password:'password', code:new TOTP({secret:Secret.fromBase32(secret)}).generate()}) });
    assert.equal(login.status, 200);
    const {token} = await login.json() as {token:string};
    const headers = {authorization:`Bearer ${token}`, 'content-type':'application/json'};
    await db.query('INSERT INTO projects(id,name,origin) VALUES($1,$1,$2)', [legacy, `https://legacy-${suffix}.test`]);
    ids.push(legacy);
    await db.query("INSERT INTO incidents(project_id,host) VALUES($1,'legacy-clone.test')", [legacy]);
    const legacyResponse = await fetch(`${base}/admin/projects/${legacy}/incidents`, {headers});
    assert.equal(legacyResponse.status, 200);
    assert.equal((await legacyResponse.json() as {host:string}[])[0].host, 'legacy-clone.test');
    ids.pop();
    const create = (name:string, origin:string) => fetch(`${base}/admin/projects`, {method:'POST', headers, body:JSON.stringify({name,origin})});
    const originA = `https://a-${suffix}.test`, originB = `https://b-${suffix}.test`;
    for (const [name, origin] of [['A', originA], ['B', originB]]) {
      const response = await create(name, origin); assert.equal(response.status, 201);
      ids.push((await response.json() as {id:string}).id);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.equal((await fetch(`${base}/admin/projects/${ids[0]}/risk-assessments`, {headers:{...headers,origin:'https://attacker.test'}})).status, 403);
    assert.equal((await create('duplicate', originA.toUpperCase() + ':443/')).status, 409);
    assert.equal((await create('invalid', 'https://example.test/path')).status, 400);
    const ports: number[] = [];
    for (const id of ids) {
      const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
      const port = (reserve.address() as AddressInfo).port; ports.push(port);
      await new Promise<void>(resolve => reserve.close(() => resolve()));
      children.push(spawn(process.execPath, ['dist/apps/server.js'], {env:{...process.env, DATABASE_URL:process.env.TEST_DATABASE_URL, PROJECT_ID:id, ALLOWED_ORIGIN:'', PORT:String(port), SMTP_PORT:'1'}, stdio:'ignore'}));
    }
    for (const port of ports) {
      let ready = false;
      for (let i=0; i<100 && !ready; i++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/runtime.js`)).ok; } catch { /* starting */ }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready);
    }
    const observation = await fetch(`http://127.0.0.1:${ports[0]}/observe`, {method:'POST',headers:{origin:'https://clone.test','content-type':'text/plain'},body:JSON.stringify({origin:'https://clone.test',signals:{medium:'cpc'}})});
    assert.equal(observation.status, 204);
    const decision = await fetch(`http://127.0.0.1:${ports[0]}/entry-decision`, {method:'POST',headers:{origin:'https://clone.test','content-type':'text/plain'},body:JSON.stringify({session:'a'.repeat(32),signals:{medium:'cpc'}})});
    assert.deepEqual(await decision.json(), {action:'OBSERVE_ONLY'});
    const riskA = await fetch(`${base}/admin/projects/${ids[0]}/risk-assessments`, {headers});
    const riskB = await fetch(`${base}/admin/projects/${ids[1]}/risk-assessments`, {headers});
    const diagnostic = await riskA.json() as {level:string;evidence_kind:string;evidence_provenance:string;evidence_reliability:string}[];
    assert.equal(diagnostic.length, 1);
    assert.equal(diagnostic[0].level, 'UNCERTAIN');
    assert.equal(diagnostic[0].evidence_kind, 'paid_utm');
    assert.equal(diagnostic[0].evidence_provenance, 'browser');
    assert.equal(diagnostic[0].evidence_reliability, 'uncorroborated');
    assert.equal((await riskB.json() as unknown[]).length, 0);
    const claim = (port:number, body:string, path='/observe') => fetch(`http://127.0.0.1:${port}${path}`, {method:'POST', headers:{origin:'https://clone.test','content-type':'text/plain'}, body});
    assert.equal((await claim(ports[0], JSON.stringify({projectId:ids[1],origin:'https://clone.test'}))).status, 400);
    assert.equal((await claim(ports[0], 'https://clone.test', `/observe?projectId=${ids[1]}`)).status, 404);
    assert.equal((await claim(ports[0], 'https://clone.test')).status, 204);
    assert.equal((await claim(ports[1], 'https://clone.test')).status, 204);
    for (const [index, host] of ['clone.test', 'clone.test'].entries()) {
      for (const kind of ['observations', 'incidents']) {
        const response = await fetch(`${base}/admin/projects/${ids[index]}/${kind}`, {headers});
        assert.equal(response.status, 200);
        const rows = await response.json() as {project_id:string,host:string}[];
        assert.equal(rows.length, 1); assert.equal(rows[0].project_id, ids[index]); assert.equal(rows[0].host, host);
      }
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    }
    for (const id of [...ids, legacy]) {
      await db.query('DELETE FROM risk_assessment_days WHERE project_id=$1', [id]);
      await db.query('DELETE FROM observations WHERE project_id=$1', [id]);
      await db.query('DELETE FROM observation_days WHERE project_id=$1', [id]);
      await db.query('DELETE FROM incidents WHERE project_id=$1', [id]);
      await db.query('DELETE FROM projects WHERE id=$1', [id]);
    }
    await db.query('DELETE FROM admin_totp_replay WHERE factor_id=$1', [factor]);
    await db.query('DELETE FROM admin_totp_codes WHERE factor_id=$1', [factor]);
    server.close(); await once(server, 'close'); await db.end();
  }
});
