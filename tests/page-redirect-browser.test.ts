import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('Chromium: bounded decision leaves navigation usable and ignores late responses', {timeout:30000}, async () => {
  const bootstrap = await readFile('runtime/bootstrap.js');
  let mode = 'redirect'; let destination = '';
  const server = createServer((req,res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    if (req.url === '/runtime.js') { res.writeHead(200, {'content-type':'application/javascript'}).end(bootstrap); return; }
    if (req.url === '/core.js') { res.writeHead(200, {'content-type':'application/javascript'}).end(''); return; }
    if (req.url === '/entry-decision') {
      if (mode === 'error') { res.writeHead(503).end(); return; }
      const send = () => res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({action: mode === 'observe' ? 'OBSERVE_ONLY' : 'PAGE_REDIRECT',version:1,destination}));
      if (mode === 'slow') setTimeout(send, 500); else send(); return;
    }
    res.writeHead(200, {'content-type':'text/html'}).end(`<h1>page</h1><a href="/next">next</a><script src="http://127.0.0.1:${port}/runtime.js"></script>`);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); if (!address || typeof address === 'string') throw Error('address'); const port=address.port;
  const clone=`http://localhost:${port}`, original=`http://127.0.0.1:${port}`; destination=original+'/approved';
  const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1']});
  try {
    const page=await browser.newPage();
    await page.goto(clone+'/clone'); await page.waitForURL(original+'/approved'); await page.waitForTimeout(300); assert.equal(page.url(),destination);
    for (mode of ['observe','error','slow']) {
      await page.goto(clone+'/clone'); await page.waitForTimeout(700); assert.equal(page.url(),clone+'/clone');
      await page.locator('a').click(); assert.equal(page.url(),clone+'/next');
    }
  } finally { await browser.close(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
