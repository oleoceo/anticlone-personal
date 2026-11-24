import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, devices } from 'playwright';

test('CTA rules are renewed on real Chromium history navigation', {timeout: 60000}, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'cta-history-'));
  t.after(() => rmSync(temp, {recursive:true, force:true}));
  const key = join(temp, 'key.pem'), cert = join(temp, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',key,'-out',cert], {stdio:'ignore'});
  const bootstrap = readFileSync(process.env.CTA_HISTORY_BOOTSTRAP ?? 'runtime/bootstrap.js','utf8')
    .replace(/^    const distribution = .*;$/m, '    const distribution = null;')
    .replace('/* CTA_DISCOVERY */', () => readFileSync('runtime/cta-discovery.js','utf8'));
  let version = 1, enabled = true, mode = 'normal', entries = 0, refreshes = 0;
  let onHeld: (() => void) | undefined;
  let clone: string, original: string;
  const server = createServer({key:readFileSync(key),cert:readFileSync(cert)}, (req,res) => {
    const path = req.url;
    if (path === '/runtime.js') {
      res.writeHead(200, {'content-type':'text/javascript'}).end(bootstrap);
    } else if (path === '/core.js') {
      res.writeHead(200, {'content-type':'text/javascript'}).end('');
    } else if (path === '/entry-decision' || path === '/cta-refresh') {
      if (path === '/entry-decision') entries++;
      else refreshes++;
      req.resume();
      const mappings = ['basic001','premium1'].map(marker => ({
        marker, kind:'a', destination:original+'/replacement-'+version+'-'+marker,
        nativeDigest:createHash('sha256').update(clone+'/native-'+marker).digest('hex')
      }));
      const decision = enabled ? {action:'REPLACE_CONVERSION',pathname:'/clone',version,mappings,original}
        : {action:'OBSERVE_ONLY',ctaVersion:version};
      const send = () => res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(decision));
      if (mode === 'fail') req.socket.destroy();
      else if (mode === 'hold') onHeld?.();
      else send();
    } else {
      res.writeHead(200, {'content-type':'text/html'}).end(path === '/clone'
        ? '<a data-anticlone-point="basic001" href="/native-basic001">Basic</a> <a data-anticlone-point="premium1" href="/native-premium1">Premium</a><script src="/runtime.js"></script>'
        : '<h1>Destination</h1>');
    }
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  clone = 'https://localhost:'+port;
  original = 'https://127.0.0.1:'+port;

  for (const cache of [true,false]) {
    const browser = await chromium.launch({
      channel:'chromium',
      ignoreDefaultArgs:cache ? ['--disable-back-forward-cache'] : [],
      args:['--host-resolver-rules=MAP localhost 127.0.0.1']
    });
    try {
      for (const mobile of [false,true]) await t.test(`${mobile ? 'mobile' : 'desktop'} / BFCache ${cache}`, async t => {
        version = 1; enabled = true; mode = 'normal'; entries = 0; refreshes = 0;
        const page = await browser.newPage({...(mobile ? devices['Pixel 7'] : {}),ignoreHTTPSErrors:true});
        try {
          await page.addInitScript(() => {
            if (location.pathname !== '/clone') return;
            addEventListener('pagehide', event => {
              delete document.documentElement.dataset.persistedShow;
              sessionStorage.setItem('persistedHide',String(event.persisted));
            });
            addEventListener('pageshow', event => {
              document.documentElement.dataset.persistedShow = String(event.persisted);
              document.documentElement.dataset.shownAt = String(performance.now());
            });
          });
          const ready = async (expected: string, marker = 'basic001') => (await page.waitForFunction(({expected,marker}) => {
            const node = document.querySelector<HTMLAnchorElement>(`[data-anticlone-point="${marker}"]`)!;
            let href = '';
            window.addEventListener('click', event => {href = node.href; event.preventDefault();}, {once:true});
            node.click();
            return href === expected && performance.now()-Number(document.documentElement.dataset.shownAt)+1;
          }, {expected,marker}, {timeout:6500})).jsonValue() as Promise<number>;
          const click = async (marker: string, expected: string) => {
            await page.locator(`[data-anticlone-point="${marker}"]`).click();
            await page.waitForURL(expected);
          };
          const back = async () => {
            await page.evaluate(() => setTimeout(() => history.back(),0));
            await page.waitForFunction(() => location.pathname === '/clone' &&
              document.documentElement.dataset.persistedShow !== undefined, undefined, {timeout:5000});
            assert.deepEqual(await page.evaluate(() => [
              sessionStorage.getItem('persistedHide'), document.documentElement.dataset.persistedShow
            ]),[String(cache),String(cache)], JSON.stringify(await page.evaluate(() =>
              (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & {notRestoredReasons?: unknown}).notRestoredReasons)));
          };
          await page.goto(clone+'/clone');
          let expected = original+'/replacement-1-basic001';
          await ready(expected);
          for (let cycle = 0; cycle < 3; cycle++) {
            await click('basic001',expected);
            if (cycle === 1) { version++; expected = original+'/replacement-2-basic001'; }
            await back();
            const elapsed = Math.round(await ready(expected));
            t.diagnostic(`Chromium ${browser.version()}, return ${cycle+1}: ${elapsed} ms, entries=${entries}, refreshes=${refreshes}`);
            if (!process.env.CTA_HISTORY_BOOTSTRAP) assert.ok(elapsed < 2000, 'artificial wait after history restoration');
            assert.equal(entries,cache ? 1 : cycle+2);
            assert.equal(refreshes,cache ? cycle+1 : 0);
          }
          if (process.env.CTA_HISTORY_BOOTSTRAP) {
            if (cache) {
              await click('basic001',expected);
              await back();
              await click('basic001',clone+'/native-basic001');
              t.diagnostic('An early post-restore click navigated to the native destination');
            }
            return;
          }

          await page.locator('[data-anticlone-point="premium1"]').evaluate(node => node.setAttribute('href','/drifted'));
          await click('premium1',clone+'/drifted');
          await back();
          await ready(expected);
          if (cache) {
            await click('premium1',clone+'/drifted');
            await back();
            await ready(expected);
          }

          await click('basic001',expected);
          enabled = false; version++;
          const disabled = page.waitForResponse(r => r.url().endsWith(cache ? '/cta-refresh' : '/entry-decision'));
          await back(); await disabled;
          await click('basic001',clone+'/native-basic001');

          enabled = true; version++; mode = 'hold';
          const held = new Promise<void>(resolve => {onHeld = resolve;});
          await back(); await held;
          await click('basic001',clone+'/native-basic001');

          mode = 'fail';
          const failed = page.waitForEvent('requestfailed',r => r.url().endsWith(cache ? '/cta-refresh' : '/entry-decision'));
          await back(); await failed;
          await click('basic001',clone+'/native-basic001');
        } finally {
          await page.close();
        }
      });
    } finally {
      await browser.close();
    }
  }
});
