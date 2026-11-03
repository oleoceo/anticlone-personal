import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('passive snapshot separates equal text, retains markers and leaves navigation unchanged', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({status:200,body:'destination'}));
    await page.goto('http://localhost/fixture');
    await page.setContent(`<section><a data-anticlone-point="basic001" href="http://localhost/basic?secret=x">Comprar</a></section><section><a data-anticlone-point="premium1" href="http://localhost/premium">Comprar</a></section><a data-anticlone-point="whatsapp" href="https://wa.me/5511999999999">WhatsApp</a><form action="http://localhost/order"><button>Enviar</button></form>`);
    await page.addScriptTag({path:'runtime/cta-inventory.js'});
    const snapshot = () => page.evaluate(() => (window as unknown as {anticloneLabInventory: () => Array<{marker:string;url:string}>}).anticloneLabInventory());
    const before = await snapshot();
    assert.deepEqual(before.slice(0,3).map(x=>x.marker),['basic001','premium1','whatsapp']);
    assert.equal(before[0].url,'http://localhost/basic');
    assert.equal(await page.locator('a').first().getAttribute('href'),'http://localhost/basic?secret=x');
    assert.equal(await page.locator('form').getAttribute('action'),'http://localhost/order');
    await page.locator('a').first().evaluate(element => {element.textContent='Texto alterado';});
    assert.equal((await snapshot())[0].marker,before[0].marker);
    assert.equal(await page.locator('a').first().evaluate(element => (element as HTMLAnchorElement).href),'http://localhost/basic?secret=x');
    await page.locator('a').first().click();
    assert.equal(page.url(),'http://localhost/basic?secret=x');
    await page.setContent('<form action="http://localhost/order"><button>Enviar</button></form>');
    await page.addScriptTag({path:'runtime/cta-inventory.js'});
    await snapshot();
    await page.locator('button').click();
    assert.equal(page.url(),'http://localhost/order?');
    assert.ok((await readFile('runtime/cta-inventory.js','utf8')).length > 0);
  } finally { await browser.close(); }
});
