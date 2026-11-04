import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('F22: native forms respect listeners registered during submit without approved-origin requests', {timeout:15000}, async () => {
  const runtime = await readFile('runtime/bootstrap.js', 'utf8');
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const requests:string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.context().route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/runtime.js') return route.fulfill({contentType:'text/javascript',body:runtime});
      if (url.pathname === '/core.js') return route.fulfill({contentType:'text/javascript',body:''});
      if (url.pathname === '/entry-decision') return route.fulfill({json:{action:'REPLACE_CONVERSION',version:1,pathname:'/clone',original:'http://127.0.0.1:8123',mappings:[{marker:'form0001',kind:'form',destination:'http://127.0.0.1:8123/approved'},{marker:'anchor01',kind:'a',destination:'http://127.0.0.1:8123/anchor-approved'}]}});
      if (url.pathname !== '/clone') return route.fulfill({contentType:'text/html',body:'<h1>Destination</h1>'});
      return route.fulfill({contentType:'text/html',body:'<a data-anticlone-point="anchor01" href="/anchor-original" target="_blank">Probe</a><form data-anticlone-point="form0001" action="/original"><button>Enviar</button></form><script src="/runtime.js"></script>'});
    });
    const decision = page.waitForResponse('**/entry-decision');
    await page.goto('http://localhost:8123/clone');
    await decision;
    await page.waitForTimeout(50);
    // An approved anchor proves this page installed the policy before testing forms.
    const popup = page.waitForEvent('popup');
    await page.getByText('Probe').click();
    const probe = await popup;
    await probe.waitForURL('http://127.0.0.1:8123/anchor-approved');
    await probe.close();
    await page.evaluate(() => {
      document.querySelector('form')!.addEventListener('submit', () => {
        window.addEventListener('submit', event => {
          event.preventDefault();
          document.body.dataset.cancelled = 'yes';
        }, {once:true});
      }, {once:true});
    });
    requests.length = 0;
    await page.getByText('Enviar').click();
    await page.waitForTimeout(100);
    assert.equal(page.url(), 'http://localhost:8123/clone');
    assert.equal(await page.locator('body').getAttribute('data-cancelled'), 'yes');
    assert.deepEqual(requests, []);
    await page.evaluate(() => {
      document.querySelector('form')!.addEventListener('submit', () => {
        window.addEventListener('submit', event => {
          (event.target as HTMLFormElement).insertAdjacentHTML('beforeend','<input name="late" value="synthetic">');
        }, {once:true});
      }, {once:true});
    });
    await page.getByText('Enviar').click();
    await page.waitForURL('http://localhost:8123/original?late=synthetic');
    assert.deepEqual(requests, ['http://localhost:8123/original?late=synthetic']);
  } finally { await browser.close(); }
});
