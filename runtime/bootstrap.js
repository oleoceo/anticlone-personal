(() => {
  try {
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const endpoint = path => new URL(path, source).href;
    // Explicit operator-requested inventory is available only on loopback laboratory pages.
    if (['localhost','127.0.0.1'].includes(location.hostname)) addEventListener('message', event => {
      try {
        const sender = new URL(event.origin), request = event.data;
        if (window.parent === window || event.source !== window.parent || !['localhost','127.0.0.1'].includes(sender.hostname) || !['http:','https:'].includes(sender.protocol) || !request || request.type !== 'anticlone-inventory-request' || typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce) || typeof request.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.surface)) return;
        if (!window.confirm('Permitir captura local dos elementos desta superficie para ' + event.origin + '?')) return;
        const script = document.createElement('script'); script.src = new URL('/cta-inventory.js', source).href;
        script.onload = () => { try { event.source.postMessage({type:'anticlone-inventory-result',nonce:request.nonce,surface:request.surface,pathname:location.pathname,candidates:window.anticloneLabInventory(request.surface)},event.origin); } catch (_) { /* No capture on failure. */ } script.remove(); };
        script.onerror = () => script.remove(); document.head.appendChild(script);
      } catch (_) { /* Untrusted message. */ }
    });
    const deadline = performance.now() + 150;
    let redirectPending = true, redirectInteracted = false, abandoned = false, suspended = false;
    let suspendCtas = () => {}, resumeCtas = () => {}, startCore = () => {}, coreLoaded = false, coreStarted = false;
    let initialPath = location.pathname, initialSearch = location.search;
    const validContext = () => !abandoned && !suspended && location.pathname === initialPath && location.search === initialSearch;
    const abandon = () => { abandoned = true; cancelRedirect(); };
    const cancelRedirect = () => { redirectPending = false; redirectInteracted = true; };
    setTimeout(() => { redirectPending = false; }, 150);
    addEventListener('pagehide', event => { cancelRedirect(); if (event.persisted) { suspended = true; suspendCtas(); } else abandon(); });
    addEventListener('pageshow', event => { if (event.persisted && suspended && !abandoned) { suspended = false; if (validContext()) { if (coreStarted) resumeCtas(); else if (coreLoaded) startCore(); } else abandon(); } });
    addEventListener('beforeunload', cancelRedirect);
    addEventListener('pointerdown', cancelRedirect, {once:true, capture:true});
    addEventListener('keydown', cancelRedirect, {once:true, capture:true});
    addEventListener('click', cancelRedirect, {once:true, capture:true});
    const routeChanged = () => {
      if (location.pathname === initialPath && location.search === initialSearch) return;
      cancelRedirect(); suspendCtas(); initialPath = location.pathname; initialSearch = location.search;
      if (!abandoned && !suspended) { if (coreStarted) resumeCtas(); else if (coreLoaded) startCore(); }
    };
    addEventListener('popstate', routeChanged);
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        routeChanged();
        return result;
      };
    }
    // One delegated listener uses the latest bounded snapshot.
    const ctaTtlMs = 120000, refreshIntervalMs = 60000;
    let activeCtas = null, listenerInstalled = false, latestCtaVersion = 0;
    const observeCtaVersion = decision => {
      if (decision && decision.action === 'OBSERVE_ONLY' && Number.isSafeInteger(decision.ctaVersion) && decision.ctaVersion > latestCtaVersion) latestCtaVersion = decision.ctaVersion;
    };
    const prepareCtas = (decision, startedWall, startedMono) => {
      try {
        if (!Number.isSafeInteger(decision.version) || decision.version < 1 || decision.version < latestCtaVersion || location.pathname !== decision.pathname || !Array.isArray(decision.mappings) || decision.mappings.length > 100) return;
        const original = new URL(decision.original);
        if (!['http:', 'https:'].includes(original.protocol) || original.origin !== decision.original || original.origin === location.origin || !['localhost','127.0.0.1'].includes(original.hostname) || !['localhost','127.0.0.1'].includes(location.hostname)) return;
        const mappings = new Map();
        const external = decision.externalDestinations ?? [];
        if (!Array.isArray(external) || external.length > 100 || external.some(url => typeof url !== 'string' || url.length > 2048)) return;
        for (const row of decision.mappings) {
          if (!row || typeof row.marker !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(row.marker) || (row.surface !== undefined && (typeof row.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.surface))) || !['a','form'].includes(row.kind) || typeof row.destination !== 'string') return;
          const target = new URL(row.destination);
          if ((target.origin !== original.origin && (target.protocol !== 'https:' || !external.includes(target.href))) || target.username || target.password || target.hash || !['http:', 'https:'].includes(target.protocol)) return;
          const entries = mappings.get(row.marker) || [];
          if (entries.some(item => item.surface === row.surface)) return;
          if (row.requiresSurface !== undefined && typeof row.requiresSurface !== 'boolean') return;
          entries.push({surface:row.surface, requiresSurface:row.requiresSurface, kind:row.kind, destination:target.href}); mappings.set(row.marker, entries);
        }
        if (!validContext() || Date.now() < startedWall || Date.now() - startedWall > 5000 || performance.now() - startedMono > 5000) return;
        latestCtaVersion = decision.version;
        activeCtas = {mappings, pathname:decision.pathname, startedWall, startedMono};
        if (!listenerInstalled) { listenerInstalled = true; install(); }
      } catch (_) { /* Keep original links. */ }
    };
    const install = () => {
          document.addEventListener('click', event => {
            try {
              if (!(event.target instanceof Element)) return;
              const node = event.target.closest('a[data-anticlone-point][href]');
              if (!node || !node.isConnected) return;
              const activate = currentEvent => {
                if (currentEvent !== event) return;
                try {
                  const snapshot = activeCtas;
                  if (!snapshot || Date.now() < snapshot.startedWall || Date.now() - snapshot.startedWall >= ctaTtlMs || performance.now() - snapshot.startedMono >= ctaTtlMs) { activeCtas = null; return; }
                  if (event.defaultPrevented || !validContext() || location.pathname !== snapshot.pathname || !node.isConnected || !node.hasAttribute('href')) return;
                  const mappings = snapshot.mappings;
                  const marker = node.getAttribute('data-anticlone-point');
                  const entries = mappings.get(marker) || [];
                  const scope = node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface');
                  const entry = scope ? entries.find(item => item.surface === scope) : entries.length === 1 && !entries[0].requiresSurface ? entries[0] : null;
                  if (!entry || entry.kind !== 'a') return;
                  const current = Array.from(document.querySelectorAll('[data-anticlone-point]'));
                  if (current.length > 1000 || current.filter(item => item.getAttribute('data-anticlone-point') === marker && (!scope || item.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface') === scope)).length !== 1) return;
                  const previous = node.getAttribute('href');
                  const replacement = entry.destination;
                  node.setAttribute('href', replacement);
                  setTimeout(() => { if (node.getAttribute('href') === replacement) node.setAttribute('href', previous); }, 0);
                } catch (_) { /* Preserve the page on incompatible DOM implementations. */ }
              };
              node.addEventListener('click', activate, {capture:true, once:true});
              setTimeout(() => node.removeEventListener('click', activate, true), 0);
            } catch (_) { /* Preserve the page on incompatible DOM implementations. */ }
          }, {capture:true});
          // Preserve native form submission until cancellation and data safety can be guaranteed.
    };
    const core = document.createElement('script');
    core.src = endpoint('core.js');
    core.async = true;
    startCore = () => {
      if (!validContext()) return;
      if (coreStarted) return;
      coreStarted = true;
      try {
        let session = sessionStorage.getItem('anticlone.lab.session');
        if (!session) { const bytes = crypto.getRandomValues(new Uint8Array(16)); session = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('anticlone.lab.session', session); }
        if (!/^[a-f0-9]{32}$/.test(session)) return;
        const signals = {};
        if (location.search.length <= 2048) {
          const params = new URLSearchParams(location.search);
          for (const key of ['gclid','fbclid','ttclid','msclkid']) { const values = params.getAll(key); if (values.length === 1 && /^[A-Za-z0-9._~-]{1,128}$/.test(values[0])) { signals.clickId = values[0]; signals.clickKey = key; break; } }
          const media = params.getAll('utm_medium'); if (media.length === 1 && ['cpc','ppc','paid','paid_social'].includes(media[0].toLowerCase())) signals.medium = media[0].toLowerCase();
        }
        if (document.referrer && document.referrer.length <= 2048) { try { const ref = new URL(document.referrer); if (['http:','https:'].includes(ref.protocol) && !ref.username && !ref.password && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(ref.hostname) && ref.hostname.length <= 253 && !ref.hostname.includes('..')) signals.referrerHost = ref.hostname.toLowerCase(); } catch (_) {} }
        // Preserve the initial declared class inputs across reloads without storing raw click IDs.
        if (signals.clickId) signals.clickId = 'present';
        const stored = sessionStorage.getItem('anticlone.lab.attribution');
        if (stored === null) sessionStorage.setItem('anticlone.lab.attribution', JSON.stringify(signals));
        else { const initial = JSON.parse(stored); if (!initial || typeof initial !== 'object' || Array.isArray(initial)) return; Object.keys(signals).forEach(key => delete signals[key]); Object.assign(signals, initial); }
        let inFlight = false, sequence = 0, lastAttempt = Date.now(), backoff = refreshIntervalMs, failed = false, controller, returnTimer;
        const expired = () => !activeCtas || Date.now() < activeCtas.startedWall || Date.now() - activeCtas.startedWall >= ctaTtlMs || performance.now() - activeCtas.startedMono >= ctaTtlMs;
        const refresh = (onReturn = false, afterEntry = false) => {
          const elapsed = Date.now() - lastAttempt;
          if (!validContext() || document.hidden || inFlight || elapsed < 0) return;
          const delay = failed ? backoff : onReturn && expired() ? 5000 : refreshIntervalMs;
          if (!afterEntry && elapsed < delay) {
            if (onReturn && expired() && !returnTimer) returnTimer = setTimeout(() => { returnTimer = undefined; refresh(true); }, delay - elapsed);
            return;
          }
          if (returnTimer) { clearTimeout(returnTimer); returnTimer = undefined; }
          inFlight = true; const id = ++sequence, wall = Date.now(), mono = performance.now(); lastAttempt = wall;
          controller = new AbortController();
          const requestController = controller, timeout = setTimeout(() => requestController.abort(), 5000);
          fetch(endpoint('cta-refresh'), {method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({session,signals,pathname:initialPath}), cache:'no-store', signal:requestController.signal})
            .then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); })
            .then(decision => { if (id !== sequence || !validContext()) return; failed = false; backoff = refreshIntervalMs; activeCtas = null; observeCtaVersion(decision); if (decision && decision.action === 'REPLACE_CONVERSION') prepareCtas(decision, wall, mono); })
            .catch(() => { if (id === sequence) { activeCtas = null; failed = true; backoff = Math.min(backoff * 2, 240000); } })
            .finally(() => { clearTimeout(timeout); if (id === sequence) { inFlight = false; controller = undefined; } });
        };
        suspendCtas = () => { activeCtas = null; ++sequence; if (controller) controller.abort(); if (returnTimer) clearTimeout(returnTimer); returnTimer = undefined; inFlight = false; controller = undefined; };
        resumeCtas = () => refresh(true);
        const timer = setInterval(() => refresh(), refreshIntervalMs);
        addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(timer); suspendCtas(); } });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
        const entryWall = Date.now(), entryMono = performance.now(), entrySequence = sequence;
        fetch(endpoint('entry-decision'), { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({session,signals,pathname:initialPath}), cache: 'no-store' })
          .then(response => { if (!response.ok) throw new Error('decision unavailable'); return response.json(); })
          .then(decision => {
            if (!validContext()) return;
            if (entrySequence === sequence) observeCtaVersion(decision);
            if (decision.action === 'REPLACE_CONVERSION') { if (entrySequence === sequence) prepareCtas(decision, entryWall, entryMono); return; }
            if (!redirectPending || redirectInteracted || performance.now() >= deadline) {
              if (decision.action === 'PAGE_REDIRECT' && entrySequence === sequence) refresh(false, true);
              return;
            }
            redirectPending = false;
            if (decision.action !== 'PAGE_REDIRECT' || !Number.isSafeInteger(decision.version) || decision.version < 1 || typeof decision.destination !== 'string') return;
            const target = new URL(decision.destination);
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || target.href === location.href || target.origin === location.origin) return;
            location.replace(target.href);
          }).catch(cancelRedirect);
      } catch (_) { cancelRedirect(); }
    };
    core.onload = () => { coreLoaded = true; startCore(); };
    document.head.appendChild(core);
  } catch (_) { /* Leave the page operational. */ }
})();
