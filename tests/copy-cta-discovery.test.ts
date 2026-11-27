import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium,devices} from 'playwright';
import {validateCopyCtaInventory} from '../apps/copy-cta-rules.js';

const original='https://original.test';
const copy='https://copy.test';
const gateway='https://gateway.test/i/fake/';
const native='https://original.test/checkout-basic.html?private=synthetic-secret';
const target='https://replacement.test/offer';
const fixture=`
<a id="basic" href="${native}">Plano básico</a>
<a id="complete" href="${native}">Plano completo</a>
<button id="buy" type="button" onclick="window.location.href='https://original.test/checkout-js.html'">Comprar</button>
<button id="offer-popup" type="button" onclick="window.open('https://original.test/checkout-popup.html','_blank')">Abrir oferta</button>
<button id="checkout-unknown" type="button" onclick="runOffer()">Oferta sem destino verificável</button>
<a href="#">Comprar em modal</a>
<button id="dynamic" type="button">Comprar oferta dinâmica</button>
<a id="whatsapp" target="_blank" href="https://wa.me/5511999999999?text=synthetic-secret">WhatsApp</a>
<a id="home" href="/home">Início</a><button id="menu" type="button" onclick="window.location='/home'">Menu</button>
<form><button id="submit" type="submit">Enviar</button></form>
<script src="${gateway}runtime.js"></script>`;

test('CTA discovery and actual desktop/mobile navigation, with an immediate native fail-open',async()=>{
  const helper=await readFile('runtime/cta-discovery.js','utf8');
  const runtime=await readFile('runtime/bootstrap.js','utf8');
  const core=await readFile('runtime/core.js','utf8');
  const browser=await chromium.launch();
  try {
    for (const mobile of [false,true]) {
      const context=await browser.newContext(mobile ? devices['Pixel 7'] : {});
      const page=await context.newPage();
      const points = new Map<string,ReturnType<typeof validateCopyCtaInventory>[number]>();
      const inventory = () => [...points.values()];
      let mappings:{marker:string;surface?:string;kind:string;destination:string;nativeDigest:string}[]=[];
      let releaseEntry:(()=>void)|undefined;
      let delay=false;
      await context.route('**/*',async route=>{
        const url=route.request().url();
        if (url===copy+'/') return route.fulfill({contentType:'text/html',body:fixture});
        if (url===gateway+'runtime.js') return route.fulfill({contentType:'application/javascript',body:runtime.replace('/* CTA_DISCOVERY */',()=>helper)});
        if (url===gateway+'core.js') return route.fulfill({contentType:'application/javascript',body:core.replace('/* CTA_DISCOVERY */',()=>helper)});
        const headers={'access-control-allow-origin':'*'};
        if (url===gateway+'entry-decision') {
          if (delay) await new Promise<void>(resolve=>{releaseEntry=resolve;});
          return route.fulfill({headers,json:mappings.length ? {action:'REPLACE_CONVERSION',version:1,pathname:'/',original,mappings,
            externalDestinations:mappings.map(item=>item.destination),operationalContext:{origin:copy,pathname:'/',original}}:{action:'OBSERVE_ONLY'}});
        }
        if (url===gateway+'observe') {
          const body=route.request().postDataJSON();
          if (body.ctas) for (const point of validateCopyCtaInventory(body.ctas)) points.set(point.surface+':'+point.marker,point);
        }
        return route.fulfill({headers,contentType:'text/html',body:'<title>Navigation committed</title>'});
      });
      const visit=()=>page.goto(copy+'/',{waitUntil:'domcontentloaded'});
      const click=(id:string)=>mobile ? page.locator('#'+id).tap() : page.locator('#'+id).click();
      await visit();
      const nextInventory=(scope?:string)=>page.waitForResponse(response=>response.url()===gateway+'observe' &&
        response.request().postData()?.includes(scope ? '"surface":"'+scope+'"' : '"ctas"')===true);
      await nextInventory();
      assert.equal(inventory().length,8);
      assert.equal(inventory().filter(point=>point.native_url===null && point.compatible===false).length,3);
      assert.equal(inventory().filter(point=>point.compatible).length,4);
      assert.equal(inventory().filter(point=>point.native_url===original+'/checkout-basic.html').length,2);
      assert.equal(new Set(inventory().map(point=>point.marker)).size,inventory().length);
      assert.ok(!JSON.stringify(inventory()).includes('synthetic-secret'));
      const popupInventory=nextInventory('exit');
      const showOffers=()=>page.evaluate(()=>{
        document.body.insertAdjacentHTML('beforeend','<dialog open data-anticlone-surface="discount"><a id="discount" href="/offer-discount.html">Desconto</a></dialog>');
        document.body.insertAdjacentHTML('beforeend','<aside data-anticlone-surface="exit"><a id="exit" href="/offer-exit.html">Oferta de saída</a></aside>');
      });
      await showOffers();
      await popupInventory;
      assert.deepEqual(inventory().filter(point=>point.surface).map(point=>point.surface),['discount','exit']);
      const offers=inventory().filter(point=>point.surface);
      const hashes=new Map([[native,'a'],['https://original.test/checkout-js.html','js'],['https://wa.me/5511999999999?text=synthetic-secret','whatsapp']].map(
        ([url,kind])=>[createHash('sha256').update(url).digest('hex'),kind]));
      mappings=inventory().filter(point=>point.compatible && hashes.has(point.native_digest)).map((point,index)=>({
        marker:point.marker,kind:point.kind==='button' ? 'button' : 'a',nativeDigest:point.native_digest,destination:target+'?point='+index,
      }));
      for (const [id,index] of [['basic',0],['complete',1],['buy',2]] as const) {
        const decision=page.waitForResponse(gateway+'entry-decision');
        const start=Date.now();
        await visit();
        await (await decision).finished();
        await click(id);
        await page.waitForURL(target+'?point='+index);
        console.log('CTA_FIRST_CLICK',JSON.stringify({mobile,id,elapsedMs:Date.now()-start,url:page.url()}));
      }
      const decision=page.waitForResponse(gateway+'entry-decision');
      await visit();
      await (await decision).finished();
      const popupTask=context.waitForEvent('page');
      await click('whatsapp');
      const popup=await popupTask;
      await popup.waitForURL(target+'?point=3');
      await popup.close();
      mappings.push(...offers.map(point=>({
        marker:point.marker,surface:point.surface,kind:'a',nativeDigest:point.native_digest,destination:target+'?surface='+point.surface,
      })));
      for (const surface of ['discount','exit']) {
        const offered=page.waitForResponse(gateway+'entry-decision');
        await visit();
        await (await offered).finished();
        const dynamic=nextInventory(surface);
        await showOffers();
        await dynamic;
        await click(surface);
        await page.waitForURL(target+'?surface='+surface);
      }
      delay=true;
      await visit();
      const clickTask=click('basic');
      await page.waitForURL(native);
      assert.equal(page.url(),native);
      releaseEntry?.();
      await clickTask;
      await context.close();
    }
  } finally { await browser.close(); }
});
