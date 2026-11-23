(() => {
  try {
    const distribution = null;
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const signals = {};
    if (location.search.length <= 2048) {
      const params = new URLSearchParams(location.search);
      for (const key of ['gclid', 'fbclid', 'ttclid', 'msclkid']) {
        const values = params.getAll(key);
        if (values.length === 1 && /^[A-Za-z0-9._~-]{1,128}$/.test(values[0])) { signals.clickId = values[0]; signals.clickKey = key; break; }
      }
      const media = params.getAll('utm_medium');
      if (media.length === 1 && ['cpc', 'ppc', 'paid', 'paid_social'].includes(media[0].toLowerCase())) signals.medium = media[0].toLowerCase();
    }
    if (document.referrer && document.referrer.length <= 2048) {
      try {
        const ref = new URL(document.referrer);
        if (['http:', 'https:'].includes(ref.protocol) && !ref.username && !ref.password && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(ref.hostname) && ref.hostname.length <= 253 && !ref.hostname.includes('..')) signals.referrerHost = ref.hostname.toLowerCase();
      } catch (_) { /* Missing or invalid referrer. */ }
    }
    const scoped = !!distribution || new URL(source).pathname.startsWith('/i/');
    const observation = fetch(new URL(distribution?.paths?.['observe'] ?? 'observe', distribution ? distribution.bases.TELEMETRY : source).href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(scoped ? {origin: location.origin, pathname: location.pathname, signals} : {origin: location.origin, signals}), keepalive: true
    }).catch(() => {});

    // Discover marked link CTAs after parsing, independently of entry decisions.
    if (scoped && location.protocol === 'https:') {
      let previous = '', timer, attempts = 0;
      const sendInventory = async () => {
        if (attempts >= 6) return;
        const nodes = document.querySelectorAll('[data-anticlone-point]');
        if (nodes.length > 1000) return;
        const counts = new Map(), points = [];
        for (const node of nodes) {
          const marker = node.getAttribute('data-anticlone-point');
          const surface = node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface') ?? '';
          if (!/^[a-zA-Z0-9_-]{8,64}$/.test(marker) || !/^[a-zA-Z0-9_-]{0,64}$/.test(surface)) continue;
          const key = surface + ':' + marker;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          if (!(node instanceof HTMLAnchorElement) || !node.getAttribute('href') ||
              node.matches('[data-anticlone-price-minor],[data-anticlone-currency],[data-anticlone-offer]')) continue;
          try {
            const url = new URL(node.getAttribute('href'), document.baseURI);
            if (!['http:','https:'].includes(url.protocol) || url.username || url.password) continue;
            if (url.href.length <= 2048) points.push({marker,surface,href:url.href,origin:url.origin});
          } catch (_) { /* An invalid href is not a candidate. */ }
        }
        const inventory = {origin:location.origin,pathname:location.pathname,ctas:[]};
        const serialize = () => JSON.stringify(inventory);
        for (const point of points) {
          if (counts.get(point.surface + ':' + point.marker) !== 1 || inventory.ctas.length >= 50) continue;
          const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(point.href));
          const native_digest = Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
          inventory.ctas.push({marker:point.marker,surface:point.surface,native_url:point.origin+'/',native_digest});
          if (new TextEncoder().encode(serialize()).length > 2048) inventory.ctas.pop();
        }
        const body = serialize();
        if ((!previous && !inventory.ctas.length) || previous === body || location.pathname!==inventory.pathname) return;
        previous = body;
        attempts++;
        fetch(new URL(distribution?.paths?.['observe'] ?? 'observe', distribution ? distribution.bases.TELEMETRY : source).href, {
          method:'POST', headers:{'Content-Type':'text/plain'}, body, credentials:'omit', keepalive:true
        }).catch(() => {});
      };
      let sending = false, rescan = false;
      const scan = () => {
        if (sending) { rescan = true; return; }
        sending = true;
        void sendInventory().catch(()=>{}).finally(()=>{
          sending = false;
          if (rescan) { rescan = false; schedule(); }
        });
      };
      const schedule = () => {
        if (attempts >= 6 || timer !== undefined) return;
        timer = setTimeout(() => { timer = undefined; scan(); }, 200);
      };
      const observer = new MutationObserver(schedule);
      const start = () => {
        scan();
        observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,
          attributeFilter:['href','data-anticlone-point','data-anticlone-surface','data-anticlone-price-minor','data-anticlone-currency','data-anticlone-offer']});
        setTimeout(() => observer.disconnect(), 10000);
      };
      const capture = () => { void observation.then(() => setTimeout(start,200)); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',capture,{once:true});
      else capture();
    }
  } catch (_) { /* Observation is best effort. */ }
})();
