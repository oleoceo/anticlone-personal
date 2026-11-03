import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { SMTPServer } from 'smtp-server';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('address'); return address.port;
}
async function until(fn: () => Promise<boolean>, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('timeout: ' + label);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { child.kill('SIGTERM'); await once(child, 'exit'); } finally { clearTimeout(timer); }
}

test('GS02: browser visits, durable incident and test SMTP alert after restart', { timeout: 90000 }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await db.query(await readFile('infra/001_initial.sql', 'utf8')); await db.query(await readFile('infra/002_alerts.sql', 'utf8')); await db.query(await readFile('infra/003_projects.sql', 'utf8')); await db.query(await readFile('infra/004_observation_sources.sql', 'utf8'));
  const project = 'gs02_' + crypto.randomUUID();
  const fixture = createServer(async (req, res) => {
    const html = await readFile(req.url === '/clone' ? 'tests/fixtures/clone.html' : 'tests/fixtures/original.html', 'utf8');
    res.writeHead(200, {'content-type':'text/html'}).end(html);
  });
  const fixturePort = await listen(fixture);
  // Reserve ports locally; no external SMTP or site is contacted.
  const reserve = createServer(); const smtpPort = await listen(reserve); await new Promise<void>(resolve => reserve.close(() => resolve()));
  const apiPort = 3000;
  const original = 'http://127.0.0.1:' + fixturePort, clone = 'http://localhost:' + fixturePort;
  await db.query("INSERT INTO incidents(project_id,host) VALUES($1,'legacy.test')", [project]);
  await db.query("INSERT INTO observations(project_id,host) VALUES($1,'legacy.test')", [project]);
  const start = () => spawn(process.execPath, ['dist/apps/server.js'], { env: {...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PROJECT_ID: project, ALLOWED_ORIGIN: original, SMTP_PORT: String(smtpPort), PORT: String(apiPort)}, stdio:['ignore','ignore','inherit'] });
  let app = start();
  const messages: string[] = [];
  let smtp: SMTPServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    process.stderr.write('GS02: launching browser\n');
    browser = await chromium.launch({headless:true, args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
    process.stderr.write('GS02: waiting for server\n');
    await until(async () => { try { return (await fetch('http://127.0.0.1:3000/runtime.js')).ok; } catch { return false; } }, 'server');
    assert.equal((await db.query('SELECT id FROM projects WHERE id=$1 AND origin=$2', [project, original])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM incidents WHERE project_id=$1 AND host='legacy.test'", [project])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM observations WHERE project_id=$1 AND host='legacy.test'", [project])).rowCount, 1);
    await db.query("DELETE FROM incidents WHERE project_id=$1 AND host='legacy.test'", [project]);
    await db.query("DELETE FROM observations WHERE project_id=$1 AND host='legacy.test'", [project]);
    const page = await browser.newPage();
    // Install independently of bootstrap; the test fixture remains unchanged for GS02.
    const coreOnly = await browser.newPage();
    await coreOnly.route('**/fallback.js', route => route.abort());
    await coreOnly.goto(clone + '/clone');
    await until(async () => (await db.query("SELECT id FROM observations WHERE project_id=$1 AND source='core'", [project])).rowCount === 1, 'core only');
    assert.equal((await db.query("SELECT id FROM observations WHERE project_id=$1 AND source='fallback'", [project])).rowCount, 0);
    await coreOnly.close();
    await db.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]);
    await db.query('DELETE FROM observations WHERE project_id=$1',[project]);
    await db.query('DELETE FROM incidents WHERE project_id=$1',[project]);
    const both = await browser.newPage();
    await both.route('**/core.js', route => route.abort());
    await both.goto(clone + '/clone');
    await until(async () => (await db.query("SELECT id FROM observations WHERE project_id=$1 AND source='fallback'", [project])).rowCount === 1, 'fallback with blocked core');
    await both.close();
    await db.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]);
    await db.query('DELETE FROM observations WHERE project_id=$1',[project]);
    await db.query('DELETE FROM incidents WHERE project_id=$1',[project]);
    const loaded: string[] = [];
    page.on('response', response => { if (response.url().endsWith('/runtime.js') || response.url().endsWith('/core.js')) loaded.push(response.url()); });
    const originalObservation = page.waitForResponse(response => response.url().endsWith('/observe'));
    await page.goto(original + '/original');
    assert.equal((await originalObservation).status(), 204);
    await until(async () => loaded.some(url => url.endsWith('/core.js')), 'core loaded');
    assert.ok(loaded.some(url => url.endsWith('/runtime.js')));
    assert.equal(await page.locator('h1').textContent(), 'Site original controlado');
    assert.equal(await page.locator('a').getAttribute('href'), '/checkout');
    await page.waitForTimeout(300);
    const failedCore = await browser.newPage();
    let coreBlocked = false;
    await failedCore.route('**/core.js', route => { coreBlocked = true; return route.abort(); });
    await failedCore.goto(original + '/original');
    await until(async () => coreBlocked, 'core blocked');
    assert.equal(await failedCore.locator('h1').textContent(), 'Site original controlado');
    assert.equal(await failedCore.locator('a').getAttribute('href'), '/checkout');
    await failedCore.locator('a').click();
    assert.ok(failedCore.url().endsWith('/checkout'));
    await failedCore.close();
    const neither = await browser.newPage();
    await neither.route('**/core.js', route => route.abort());
    await neither.route('**/fallback.js', route => route.abort());
    await neither.goto(original + '/original');
    await neither.locator('a').click();
    assert.ok(neither.url().endsWith('/checkout'));
    await neither.close();
    const failedBackend = await browser.newPage();
    let observationBlocked = false;
    await failedBackend.route('**/observe', route => { observationBlocked = true; return route.abort(); });
    await failedBackend.goto(original + '/original');
    await until(async () => observationBlocked, 'backend blocked');
    assert.equal(await failedBackend.locator('h1').textContent(), 'Site original controlado');
    assert.equal(await failedBackend.locator('a').getAttribute('href'), '/checkout');
    await failedBackend.locator('a').click();
    assert.ok(failedBackend.url().endsWith('/checkout'));
    await failedBackend.close();
    assert.equal((await db.query('SELECT id FROM incidents WHERE project_id=$1',[project])).rowCount, 0);
    process.stderr.write('GS02: opening clone\n');
    await page.goto(clone + '/clone');
    await until(async () => (await db.query('SELECT id FROM incidents WHERE project_id=$1',[project])).rowCount === 1, 'incident');
    await until(async () => (await db.query('SELECT attempts FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 AND attempts>0',[project])).rowCount === 1, 'SMTP failure');
    await page.reload();
    await until(async () => (await db.query('SELECT id FROM observations WHERE project_id=$1',[project])).rowCount === 2, 'both sources');
    assert.deepEqual((await db.query('SELECT source FROM observations WHERE project_id=$1 ORDER BY source',[project])).rows.map(row => row.source), ['core', 'fallback']);
    const before = await db.query('SELECT i.host,i.status,a.sent_at FROM incidents i JOIN alert_outbox a ON a.incident_id=i.id WHERE i.project_id=$1',[project]);
    assert.equal(before.rowCount,1); assert.equal(before.rows[0].host,'localhost'); assert.equal(before.rows[0].status,'unverified'); assert.equal(before.rows[0].sent_at,null);
    assert.equal((await db.query('SELECT id FROM observations WHERE project_id=$1',[project])).rowCount,2);
    process.stderr.write('GS02: restarting after SMTP failure\n');
    await stop(app); await db.end();
    const reconnected = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      smtp = new SMTPServer({ authOptional:true, disabledCommands:['STARTTLS','AUTH'], onData(stream, _session, callback) { let message=''; stream.on('data', chunk => { message += String(chunk); }); stream.on('end', () => { messages.push(message); callback(); }); } });
      await new Promise<void>((resolve, reject) => {
        smtp!.once('error', reject);
        smtp!.listen(smtpPort, '127.0.0.1', resolve);
      });
      await reconnected.query(`UPDATE alert_outbox SET next_attempt=now() WHERE incident_id IN (SELECT id FROM incidents WHERE project_id=$1)`,[project]);
      app = start();
      await until(async () => { try { return (await fetch('http://127.0.0.1:3000/runtime.js')).ok; } catch { return false; } }, 'restart');
      await until(async () => messages.length === 1 && (await reconnected.query('SELECT a.sent_at FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 AND a.sent_at IS NOT NULL',[project])).rowCount === 1, 'email retry');
      process.stderr.write('GS02: restarting after delivery\n');
      await stop(app); app = start();
      await until(async () => { try { return (await fetch('http://127.0.0.1:3000/runtime.js')).ok; } catch { return false; } }, 'restart after delivery');
      await page.reload(); await page.waitForTimeout(1400);
      assert.equal(messages.length,1); assert.match(messages[0], /Unverified browser claim for host: localhost/);
      assert.equal((await reconnected.query('SELECT id FROM incidents WHERE project_id=$1',[project])).rowCount,1);
      assert.equal((await reconnected.query('SELECT id FROM observations WHERE project_id=$1',[project])).rowCount,2);
      const request = (body: string, origin = clone, contentType = 'text/plain') => fetch('http://127.0.0.1:3000/observe',{method:'POST',headers:{origin,'content-type':contentType},body});
      assert.equal((await request('invalid')).status,400);
      assert.equal((await request(clone, original)).status,400);
      assert.equal((await request(clone, clone, 'application/json')).status,415);
      assert.equal((await request('x'.repeat(2049))).status,413);
      let limited = false; for (let i=0;i<65;i++) if ((await request(clone)).status === 429) { limited=true; break; }
      assert.ok(limited, 'flood is rate limited');
      // Expired incidents also expire unsent alerts, deliberately bounded by retention.
      await reconnected.query("WITH old AS (INSERT INTO incidents(project_id,host,last_seen) VALUES($1,'expired.test',now()-interval '31 days') RETURNING id) INSERT INTO alert_outbox(incident_id) SELECT id FROM old", [project]);
      await until(async () => (await reconnected.query("SELECT id FROM incidents WHERE project_id=$1 AND host='expired.test'", [project])).rowCount === 0, 'incident and pending alert expiry');
      assert.equal((await reconnected.query("SELECT a.id FROM alert_outbox a JOIN incidents i ON i.id=a.incident_id WHERE i.project_id=$1 AND i.host='expired.test'", [project])).rowCount, 0);
      // Retention removes expired evidence while preserving recent incident and outbox.
      await reconnected.query("UPDATE observations SET observed_at=now()-interval '8 days' WHERE project_id=$1",[project]);
      await until(async () => (await reconnected.query('SELECT id FROM observations WHERE project_id=$1',[project])).rowCount === 0, 'retention');
    } finally {
      await stop(app);
      await reconnected.query('DELETE FROM observations WHERE project_id=$1',[project]);
      await reconnected.query('DELETE FROM observation_source_days WHERE project_id=$1',[project]);
      await reconnected.query('DELETE FROM observation_days WHERE project_id=$1',[project]);
      await reconnected.query('DELETE FROM incidents WHERE project_id=$1',[project]);
      await reconnected.query('DELETE FROM projects WHERE id=$1',[project]);
      await reconnected.end();
    }
  } finally {
    if (browser) await browser.close(); await stop(app); if (smtp) await new Promise<void>(resolve => smtp!.close(() => resolve()));
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (!db.ended) await db.end();
  }
});
