// Runs only inside the NPM clone with --network none and no published ports.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createServer, request} = require('node:https');
const {setTimeout: delay} = require('node:timers/promises');

const host = 'protect.leoceo.online';
const cert = name => readFileSync('/gate/' + name);
const pin = process.argv[2];
let received = 0;
let tcp = 0;
let probes = 0;
const held = new Set();
const backend = createServer({
  key: cert('server.key'), cert: cert('server.crt'), ca: cert('client-ca.crt'),
  requestCert: true, rejectUnauthorized: true,
}, (req, res) => {
  received++;
  if (req.socket.getPeerCertificate().fingerprint256 !== pin ||
      req.socket.servername !== host || req.headers.host !== host ||
      req.headers['x-forwarded-proto'] !== 'https' ||
      req.headers['x-forwarded-for'] !== '127.0.0.1' ||
      ['cf-connecting-ip', 'forwarded', 'x-forwarded-host', 'x-real-ip'].some(header => header in req.headers)) {
    res.writeHead(403).end();
  } else if (req.url === '/core.js') {
    held.add(res);
    res.on('close', () => held.delete(res));
  } else {
    res.writeHead(200).end('upstream fixture');
  }
});
backend.on('connection', () => tcp++);

function send(servername = host, path = '/healthz', size = 0) {
  return new Promise((resolve, reject) => {
    const forged = '192.0.2.' + (++probes % 200 + 1);
    // Front-end public TLS is checked separately against the installed trust chain.
    const req = request({hostname: '127.0.0.1', port: 443, servername, path, agent: false,
      rejectUnauthorized: false, timeout: 4000, method: size ? 'POST' : 'GET',
      headers: {Host: servername, 'CF-Connecting-IP': forged, Forwarded: 'for=' + forged,
        'X-Real-IP': forged, 'X-Forwarded-For': forged,
        ...(size ? {'Content-Length': size} : {})}}, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(Error('clone probe timeout')));
    req.on('error', reject);
    req.end(size ? 'x'.repeat(size) : undefined);
  });
}

backend.listen(13003, '127.0.0.1', async () => {
  try {
    assert.equal(await send(), 200, 'scoped route uses authenticated upstream');
    for (const path of ['/admin', '/admin/ui/', '/login', '/login/']) {
      assert.equal(await send(host, path), 404);
    }
    assert.equal(await send(host, '/observe', 2049), 413);
    const before = received;
    const burst = [];
    for (let i = 0; i < 45; i++) burst.push(await send());
    assert.ok(burst.includes(200) && burst.includes(429));
    assert.equal(received - before, burst.filter(status => status === 200).length);
    const beforeFallback = received;
    const beforeFallbackTcp = tcp;
    assert.equal(await send(host, '/unlisted'), 429);
    assert.equal(received, beforeFallback);
    assert.equal(tcp, beforeFallbackTcp);
    for (let i = 0; i < 24; i++) assert.equal(await send('other.fixture.test'), 200);
    // Refill 20 burst tokens at the contractual rate of 2/s.
    await delay(11_000);
    const beforeActive = received;
    const beforeTcp = tcp;
    const active = Promise.all(Array.from({length: 10}, () => send(host, '/core.js')));
    active.catch(() => {}); // The awaited assertion below reports any failure.
    for (let i = 0; i < 100 && held.size < 10; i++) await delay(10);
    assert.equal(held.size, 10);
    assert.equal(await send(host, '/core.js'), 429);
    assert.equal(received - beforeActive, 10);
    assert.equal(tcp - beforeTcp, 10);
    for (const res of held) res.writeHead(200).end('released');
    assert.deepEqual(await active, Array(10).fill(200));
    assert.equal(await send(), 200);
    console.log('PASS normal, body, rotas, mTLS, taxa 2/s, burst 20, concorrência 10, recuperação e host isolado.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const res of held) res.destroy();
    backend.closeAllConnections();
    backend.close();
  }
});
