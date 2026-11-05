import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { collectVisibleText, interpretText } from '../apps/commercial-interpreter.js';

const one = (text:string, struck=false) => { const rows=interpretText({text,struck}); assert.equal(rows.length,1,text); return rows[0]; };
test('exact international monetary grammars and exponents', () => {
  for (const [text,code,minor] of [
    ['Preço: R$ 1.234,56','BRL','123456'],['Price: BRL 1,234.56','BRL','123456'],
    ['Price: USD 1,234.56','USD','123456'],['Price: 1.234,56 USD','USD','123456'],
    ['Price: € 1 234,56','EUR','123456'],['Price: EUR 1\u202f234.56','EUR','123456'],
    ['Price: £ 1,234.56','GBP','123456'],["Price: GBP 1'234.56",'GBP','123456'],
    ['Price: JPY 1,234','JPY','1234'],['Price: JP¥ 1.234','JPY','1234'],
    ['Price: KWD 1,234.567','KWD','1234567'],['Price: 1.234,567 KWD','KWD','1234567'],
    ['Price: USD 999999999999999999.99','USD','99999999999999999999'],
    ['Price: KWD 0.001','KWD','1'],['Price: JPY 0','JPY','0'],
  ]) { const row=one(text); assert.equal(row.currency,code,text); assert.equal(row.minorUnits,minor,text); assert.equal(row.meaning,'PRICE_CURRENT',text); }
});
test('reject invalid grouping, precision, boundaries and hostile input without partial numbers', () => {
  for (const text of ['USD 12,34.56','BRL 1.23,45','EUR 1,23,456.78','GBP 01,234.56','JPY 12.50','KWD 12.50','USD 12.3456','USD 1 23.45','USD 1,234 567.89','USD 9999999999999999999','USD 10%','-USD 10','USD 10.00abc','USD 10..00','USD 1.234.56','USD 01','USD 10_000','USD 10\u066b50','USD 10\u066c00']) {
    const rows=interpretText({text}); assert.ok(rows.length,text); assert.ok(rows.every(r=>r.status!=='RESOLVED'),text);
  }
  for (const text of ['tel +55 (11) 99999-9999','50% off, 12 units','123.45','\u202eUSD 10','USD 10\u0000', 'x'.repeat(513)]) assert.deepEqual(interpretText({text}),[],text);
  assert.deepEqual(interpretText(null as never),[]);
  assert.equal(one('$ 10.00').status,'UNRESOLVED');
  assert.equal(one('\u00a5 10').status,'UNRESOLVED');
  assert.equal(one('USD 10 EUR').status,'UNRESOLVED');
  assert.equal(one('KWD 1.234').status,'UNRESOLVED');
});
test('meaning requires complete bounded evidence and never promotes qualifiers to full price', () => {
  for (const [text,meaning,struck] of [
    ['Agora: R$ 90,00','PRICE_CURRENT',false],['De: R$ 100,00','PRICE_PREVIOUS',false],
    ['USD 100','PRICE_PREVIOUS',true],['Economize R$ 10,00','SAVINGS',false],
    ['Save USD 10','SAVINGS',false],['12x de R$ 10,00 sem juros','INSTALLMENT',false],
    ['Parcela: BRL 10','INSTALLMENT',false],['Total: BRL 120','PRICE_CURRENT',false],
    ['Assinatura: BRL 10/mês','RECURRING',false],['USD 10 per month','RECURRING',false],
    ['R$ 10,00','UNKNOWN',false],['Economia: preço USD 10','UNKNOWN',false],
    ['Preço USD 10 por mês','UNKNOWN',false],['Price USD 10','UNKNOWN',true],
    ['História do preço USD 10 em 1990','UNKNOWN',false],
  ] as const) { const r=one(text,struck); assert.equal(r.meaning,meaning,text); assert.ok(r.reason); assert.equal(r.evidence,text); }
  const rows=interpretText({text:'De USD 100 por USD 90'}); assert.equal(rows.length,2); assert.ok(rows.every(r=>r.meaning==='UNKNOWN'));
});
test('Chromium localhost rendered extraction is read-only and isolated from active commercial import', async () => {
  const html=`<!doctype html><meta charset="utf-8"><p>Preço: R$ 1.234,56</p><p><s>USD 100</s></p><p>Agora USD 90</p><p>Economize <b>USD 10</b></p><p>12x de BRL 10</p><p>USD 10/month</p><p>USD 10 e EUR 20</p><p hidden>Price USD 999</p><p style="opacity:0">Price USD 998</p><script type="application/json">"Price USD 997"</script><a href="/native" aria-describedby="price">Buy</a><p id="price" itemscope itemtype="https://schema.org/Offer">Price GBP 10</p>`;
  const server=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(html)).listen(0,'127.0.0.1'); await once(server,'listening');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    let requests=0; page.on('request',()=>requests++);
    const before=await page.content();
    await page.evaluate(()=>{ (window as unknown as {mutations:number}).mutations=0; new MutationObserver(r=>{(window as unknown as {mutations:number}).mutations+=r.length;}).observe(document,{subtree:true,attributes:true,childList:true,characterData:true}); });
    const capture=await page.evaluate(collectVisibleText); assert.equal(capture.status,'COMPLETE');
    const rows=capture.runs.flatMap(interpretText);
    assert.equal(rows.length,9); assert.deepEqual(rows.slice(0,6).map(r=>r.meaning),['PRICE_CURRENT','PRICE_PREVIOUS','PRICE_CURRENT','SAVINGS','INSTALLMENT','RECURRING']);
    assert.ok(rows.every(r=>!r.raw.includes('99'))); assert.equal(requests,0); assert.equal(await page.content(),before);
    assert.equal(await page.evaluate(()=>(window as unknown as {mutations:number}).mutations),0);
    await page.setContent('<p>'+ 'x'.repeat(20001) +'</p>'); assert.deepEqual(await page.evaluate(collectVisibleText),{status:'LIMIT_EXCEEDED',runs:[]});
  } finally { await browser.close(); server.close(); }
});
test('module has no imports, persistence, policy or production callers', async () => {
  const source=await readFile('apps/commercial-interpreter.ts','utf8');
  assert.doesNotMatch(source,/\bimport\b|\bfetch\s*\(|XMLHttpRequest|cta_commercial_references|review_required|COMMERCIAL_CHANGED|UNCERTAIN|ctaDecision|addEventListener|innerHTML\s*=/);
  for (const dir of ['apps','runtime']) for (const file of await readdir(dir)) {
    if (file==='commercial-interpreter.ts' || !/\.(ts|js)$/.test(file)) continue;
    assert.ok(!(await readFile(`${dir}/${file}`,'utf8')).includes('commercial-interpreter'),file);
  }
});
