    // Inlined in bootstrap and core by the runtime distributor.
    const discoverCtas = (() => {
      const selector = 'a[href],button,[data-anticlone-point]';
      const markerPattern = /^[a-zA-Z0-9_-]{8,64}$/;
      const surfacePattern = /^[a-zA-Z0-9_-]{0,64}$/;
      const commercial = /(?:^|[^a-z])(?:checkout|check-out|comprar|compra|buy|purchase|order|oferta|offer|promo|payment|pagamento|whatsapp)(?:[^a-z]|$)/i;
      const knownPath = /^\/(?:checkout|check-out|comprar|compra|buy|purchase|order|oferta|offer|promo|payment|pagamento)(?:-(?:basico|completo|teste|basic|complete|standard|premium|discount|exit|popup|js|trial)){0,4}(?:\.html)?\/?$/i;
      const declaredPrice = '[data-anticlone-price-minor],[data-anticlone-currency],[data-anticlone-offer]';
      const countKey = ({marker,surface}) => surface + ':' + marker;
      const identifier = value => {
        let first = 2166136261, second = 0x9e3779b9;
        for (let index=0; index<value.length; index++) {
          first = Math.imul(first ^ value.charCodeAt(index),16777619);
          second = Math.imul(second ^ value.charCodeAt(index),1597334677);
        }
        return 'auto-' + [first,second].map(part=>(part>>>0).toString(16).padStart(8,'0')).join('');
      };
      const describe = node => {
        const explicit = node.getAttribute('data-anticlone-point');
        const surface = node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface') ?? '';
        if (!surfacePattern.test(surface) || explicit !== null && !markerPattern.test(explicit)) return null;
        const anchor = node instanceof HTMLAnchorElement;
        const script = node.getAttribute('onclick') ?? '';
        const button = node instanceof HTMLButtonElement;
        const navigation = button && node.type==='button' && !node.closest('form') && script.length<=2048
          ? /^\s*(?:window\.)?location(?:\.href)?\s*=\s*(['"])([^'"\\\r\n]+)\1\s*;?\s*$/.exec(script)
          : null;
        const opening = button && script.length<=2048
          ? /^\s*window\.open\(\s*(['"])([^'"\\\r\n]+)\1(?:\s*,\s*(['"])(?:_blank|_self)\3)?\s*\)\s*;?\s*$/.exec(script)
          : null;
        const declared = node.getAttribute('data-checkout-url') ?? node.getAttribute('data-checkout');
        const href = anchor ? node.getAttribute('href') : navigation?.[2] ?? opening?.[2] ?? declared;
        let url;
        if (href && !href.startsWith('#') && href.length<=2048) {
          try {
            const parsed = new URL(href,document.baseURI);
            if (['http:','https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.href.length<=2048) url=parsed;
          } catch (_) { /* Candidate has no verified URL. */ }
        }
        const whatsapp = url?.protocol==='https:' && ['wa.me','api.whatsapp.com','web.whatsapp.com'].includes(url.hostname);
        const appLink = anchor && /^whatsapp:/i.test(href ?? '');
        const hint = (node.textContent ?? '').trim().slice(0,100) + ' ' + node.id.slice(0,128) + ' ' + (node.getAttribute('class') ?? '').slice(0,256) + ' ' + (node.getAttribute('aria-label') ?? '').slice(0,100);
        if (!explicit && !whatsapp && !appLink && !declared && !commercial.test((url?.hostname ?? '')+' '+(url?.pathname ?? '')+' '+hint)) return null;
        if (!explicit && (anchor && !url && !appLink || button && !script && !declared)) return null;
        const context = node.parentElement?.closest('[id]')?.id ?? '';
        const identity = [node.tagName,node.id.slice(0,128),context.slice(0,128),url?.href ?? '',button ? script.slice(0,2048) : ''];
        const kind = button ? 'button' : whatsapp || appLink ? 'whatsapp' : 'link';
        const evidence = explicit ? 'marker' : navigation || opening ? 'inline' : declared ? 'attribute' : 'destination';
        const liveInlineHandler = navigation && node.onclick &&
          Function.prototype.toString.call(node.onclick) === 'function onclick(event) {\n'+script+'\n}';
        const compatible = !!url && !node.matches(declaredPrice) &&
          (anchor && !node.hasAttribute('download') && (explicit!==null || !script) || !!liveInlineHandler && url.protocol==='https:');
        const native_url = url ? url.origin + (knownPath.test(url.pathname) ? url.pathname : '/') : null;
        return {marker:explicit ?? identifier(JSON.stringify(identity)),surface,kind,evidence,compatible,native_url,href:url?.href,navigation:!!navigation,script};
      };
      const collect = () => {
        const marked = document.querySelectorAll('[data-anticlone-point]');
        if (marked.length>1000) return [];
        const automatic = document.querySelectorAll('a[href]:not([data-anticlone-point]),button:not([data-anticlone-point])');
        const nodes = automatic.length<=1000 ? [...marked,...automatic] : marked;
        const points = [], counts = new Map();
        for (const node of nodes) {
          const point = describe(node);
          if (!point) continue;
          points.push({node,point});
          const key=countKey(point);
          counts.set(key,(counts.get(key) ?? 0)+1);
        }
        return points.map(({node,point})=>({node,point,unique:counts.get(countKey(point))===1}));
      };
      return {describe,collect,selector,attributes:['href','onclick','id','type','download','data-checkout','data-checkout-url',
        'data-anticlone-point','data-anticlone-surface','data-anticlone-price-minor','data-anticlone-currency','data-anticlone-offer']};
    })();
