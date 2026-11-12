import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright';

// Browser compatibility of the visual scope, independent of policy decisions.
// Real policy/backend/Chromium timing is covered in f18-timing.test.ts.
test('F18 explicit visual scope: timeout, CSS transitions, native early click and opt-out',async()=>{
  const bootstrap=await readFile('runtime/bootstrap.js');let mode='slow',markup='';
  const server=createServer((req,res)=>{
    if(req.url==='/runtime.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(bootstrap);return;}
    if(req.url==='/core.js'){if(mode==='blocked')res.writeHead(503).end();else setTimeout(()=>res.writeHead(503).end(),400);return;}
    res.writeHead(200,{'content-type':'text/html'}).end(`<style>section{opacity:.6;transition:opacity 2s linear}</style>${markup}<p id="unmarked">Visible unrelated content</p><script src="/runtime.js"></script>`);
  }).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  const browser=await chromium.launch();
  try{
    for(const kind of ['transition','longhands','original','unmarked','body','overflow','blocked','early']){
      mode=kind==='blocked'?'blocked':'slow';
      const attr=`data-anticlone-render-gate="${kind==='original'?base:'https://owner.test'}"`;
      markup=kind==='body'?`<script>document.body.setAttribute('data-anticlone-render-gate','https://owner.test')</script><section id="scope">Content</section>`:
        `<section id="scope" ${kind==='unmarked'?'':attr} style="opacity:.7 !important;transition:opacity 2s linear !important"><a href="#native">Native</a></section>`;
      if(kind==='overflow')markup+=Array.from({length:20},()=>`<section ${attr}>Other</section>`).join('');
      if(kind==='longhands')markup=`<section id="scope" ${attr} style="opacity:.7;transition-property:opacity!important;transition-duration:2s"><a href="#native">Native</a></section>`;
      const page=await browser.newPage();
      await page.addInitScript(()=>{
        const state=window as typeof window&{gateChanges:{at:number;opacity:string}[]};state.gateChanges=[];
        new MutationObserver(records=>{if(records.some(r=>(r.target as Element).id==='scope')){const scope=document.querySelector('#scope');if(scope)state.gateChanges.push({at:performance.now(),opacity:getComputedStyle(scope).opacity});}}).observe(document,{subtree:true,attributes:true,attributeFilter:['style']});
      });
      await page.goto(base,{waitUntil:'domcontentloaded'});
      assert.equal(await page.locator('#unmarked').evaluate(n=>getComputedStyle(n).opacity),'1');
      if(['original','unmarked','body','overflow'].includes(kind)){
        assert.equal(await page.locator('#scope').evaluate(n=>getComputedStyle(n).opacity),kind==='body'?'0.6':'0.7');
        assert.notEqual(await page.locator('body').evaluate(n=>getComputedStyle(n).opacity),'0');
      }else if(kind==='early'){
        await page.locator('a').click();assert.equal(page.url(),base+'/#native');
      }
      await page.waitForTimeout(230);
      const result=await page.locator('#scope').evaluate(n=>({opacity:getComputedStyle(n).opacity,style:n.getAttribute('style')}));
      assert.equal(result.opacity,kind==='body'?'0.6':'0.7',kind+' fully restored without author transition');
      if(kind==='transition'){
        assert.match(result.style!,/opacity: 0.7 !important/);assert.match(result.style!,/transition: opacity 2s linear !important/);
        const changes=await page.evaluate(()=>(window as typeof window&{gateChanges:{at:number;opacity:string}[]}).gateChanges);
        const hidden=changes.find(x=>x.opacity==='0'),released=changes.find(x=>hidden&&x.at>hidden.at&&x.opacity==='0.7');
        assert.ok(hidden&&released,JSON.stringify(changes));assert.ok(released.at-hidden.at<=200,'150ms timer plus up to 50ms browser scheduling tolerance');
        console.log('F18_GATE_RELEASE_MS',released.at-hidden.at);
      }
      if(kind==='longhands'){
        const styles=await page.locator('#scope').evaluate(n=>{const s=(n as HTMLElement).style;return [s.getPropertyValue('transition-property'),s.getPropertyPriority('transition-property'),s.getPropertyValue('transition-duration')];});
        assert.deepEqual(styles,['opacity','important','2s']);
      }
      await page.close();
    }
  }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
});
