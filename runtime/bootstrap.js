(() => {
  try {
    const distribution = null;
    /* CTA_DISCOVERY */
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const endpoint = path => new URL(distribution?.paths?.[path] ?? path, distribution ? distribution.bases.TELEMETRY : source).href;
    // Explicit operator-requested inventory is available only on loopback laboratory pages.
    if (['localhost','127.0.0.1'].includes(location.hostname)) addEventListener('message', event => {
      try {
        const sender = new URL(event.origin), request = event.data;
        if (window.parent === window || event.source !== window.parent || !['localhost','127.0.0.1'].includes(sender.hostname) || !['http:','https:'].includes(sender.protocol) || !request || request.type !== 'anticlone-inventory-request' || typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce) || typeof request.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.surface)) return;
        if (!window.confirm('Permitir captura local dos elementos desta superficie para ' + event.origin + '?')) return;
        const script = document.createElement('script'); script.src = new URL(distribution ? (distribution.paths?.['cta-inventory.js'] ?? 'cta-inventory.js') : '/cta-inventory.js', distribution ? distribution.bases.STATIC_ASSETS : source).href;
        script.onload = () => { try { event.source.postMessage({type:'anticlone-inventory-result',nonce:request.nonce,surface:request.surface,pathname:location.pathname,candidates:window.anticloneLabInventory(request.surface)},event.origin); } catch (_) { /* No capture on failure. */ } script.remove(); };
        script.onerror = () => script.remove(); document.head.appendChild(script);
      } catch (_) { /* Untrusted message. */ }
    });
    const started = performance.now(), deadline = started + 150;
    const discoveryVersion = typeof discoverCtas !== 'undefined' ? ';ac-discovery=2' : '';
    const scoped = !!distribution || new URL(source).pathname.startsWith('/i/');
    let visit, outcome, handoffElapsed;
    const initialEntryPath = location.pathname;
    const reportEntry = phase => {
      if (!visit || outcome === phase) return;
      outcome = phase;
      try {
        const measured = Math.max(0,Math.min(60000,Math.round(performance.now()-started)));
        const elapsed = ['REDIRECT_HANDOFF','PAGE_LEFT'].includes(phase) ? handoffElapsed ?? measured : measured;
        navigator.sendBeacon(endpoint('observed-action'),new Blob([JSON.stringify({pathname:initialEntryPath,visit,phase,elapsed})],{type:'text/plain'}));
      } catch (_) { /* Diagnostics are best effort. */ }
    };
    // Optional owner-authored visual scope. Never infer a page-wide gate.
    // Opacity keeps layout and native hit-testing intact during early interaction.
    const gated = [];
    const releaseGate = () => {
      for (const {node,value,priority,transition,transitionPriority} of gated.splice(0)) {
        if (node.style.getPropertyValue('opacity') === '0' && node.style.getPropertyPriority('opacity') === 'important') {
          if (value) node.style.setProperty('opacity',value,priority); else node.style.removeProperty('opacity');
        }
        if (node.style.getPropertyValue('transition-property') === 'none' && node.style.getPropertyPriority('transition-property') === 'important') {
          // Flush the restored opacity while transitions are still disabled.
          // Otherwise the owner's CSS can turn a 150ms gate into a multi-second fade.
          getComputedStyle(node).opacity;
          if (transition) node.style.setProperty('transition-property',transition,transitionPriority); else node.style.removeProperty('transition-property');
        }
      }
    };
    let redirectPending = true, redirectInteracted = false, abandoned = false, suspended = false;
    let suspendCtas = () => {}, resumeCtas = () => {};
    let initialPath = location.pathname, initialSearch = location.search;
    const validContext = () => !abandoned && !suspended && location.pathname === initialPath && location.search === initialSearch;
    const abandon = () => { abandoned = true; cancelRedirect(); };
    const cancelRedirect = phase => {
      const pending = redirectPending;
      redirectPending = false; redirectInteracted = true; releaseGate();
      if (pending && phase) reportEntry(phase);
    };
    setTimeout(() => {
      const pending = redirectPending;
      redirectPending = false; releaseGate();
      if (pending) reportEntry('TIMEOUT');
    }, Math.max(0,deadline-performance.now()));
    const scopes = document.querySelectorAll('[data-anticlone-render-gate]');
    if (scopes.length <= 20) for (const node of scopes) {
      try {
        const declared=node.getAttribute('data-anticlone-render-gate'), owner=new URL(declared);
        if (!(node instanceof HTMLElement) || ['HTML','BODY'].includes(node.tagName) || owner.origin !== declared || owner.origin === location.origin || !['http:','https:'].includes(location.protocol) || !(owner.protocol === 'https:' || owner.protocol === 'http:' && ['localhost','127.0.0.1'].includes(owner.hostname)) || performance.now() >= deadline) continue;
        gated.push({node,value:node.style.getPropertyValue('opacity'),priority:node.style.getPropertyPriority('opacity'),transition:node.style.getPropertyValue('transition-property'),transitionPriority:node.style.getPropertyPriority('transition-property')});
        node.style.setProperty('transition-property','none','important');
        node.style.setProperty('opacity','0','important');
      } catch (_) { /* Missing or invalid explicit scope remains visible. */ }
    }
    addEventListener('pagehide', event => { if (outcome==='REDIRECT_HANDOFF') reportEntry('PAGE_LEFT'); cancelRedirect(); if (event.persisted) { suspended = true; suspendCtas(); } else abandon(); });
    addEventListener('pageshow', event => { if (event.persisted && suspended && !abandoned) { suspended = false; if (validContext()) resumeCtas(true); else abandon(); } });
    addEventListener('beforeunload', () => cancelRedirect());
    addEventListener('pointerdown', () => cancelRedirect('INTERACTION'), {once:true, capture:true});
    addEventListener('keydown', () => cancelRedirect('INTERACTION'), {once:true, capture:true});
    addEventListener('click', () => cancelRedirect('INTERACTION'), {once:true, capture:true});
    const routeChanged = () => {
      if (location.pathname === initialPath && location.search === initialSearch) return;
      cancelRedirect('CONTEXT_CHANGED'); suspendCtas(); latestCtaVersion = 0; initialPath = location.pathname; initialSearch = location.search;
      if (!abandoned && !suspended) resumeCtas();
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
    // Only explicitly configured public labels are copied; existing destination parameters win.
    const attributed = (destination, rules) => {
      const target = new URL(destination), permitted = rules && rules[destination];
      if (!permitted || typeof permitted !== 'object' || Array.isArray(permitted) || location.search.length > 2048) return target.href;
      const source = new URLSearchParams(location.search);
      const protectedKeys = new Set(Array.from(target.searchParams.keys(), key => key.toLowerCase()));
      for (const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']) {
        const values = source.getAll(key), allow = permitted[key];
        if (!protectedKeys.has(key) && values.length === 1 && Array.isArray(allow) && allow.includes(values[0])) target.searchParams.append(key, values[0]);
      }
      return target.href;
    };
    // CORS keeps the receipt bound to the document Origin. Keepalive lets
    // the observation outlive the document without blocking navigation.
    const observe = (path, payload) => {
      try {
        void fetch(endpoint(path), {method:'POST', headers:{'Content-Type':'text/plain'},
          body:JSON.stringify(payload), credentials:'omit', keepalive:true}).catch(() => {});
      } catch (_) { /* Observation never gates navigation. */ }
    };
    const reportAction = (receipt, marker, surface) => {
      if (typeof receipt !== 'string') return;
      try {
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2,'0')).join('');
        const event = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
        const payload = {receipt,event,marker,surface};
        if (marker !== null) observe('observed-action', payload);
        else navigator.sendBeacon(endpoint('observed-action'), new Blob([JSON.stringify(payload)], {type:'text/plain'}));
      } catch (_) { /* Observation never gates navigation. */ }
    };
    const operationalContextMatches = decision => {
      const context=decision.operationalContext;
      return context && location.protocol==='https:' && context.origin===location.origin && context.pathname===location.pathname && context.original!==location.origin;
    };
    const prepareCtas = (decision, startedWall, startedMono) => {
      try {
        if (!Number.isSafeInteger(decision.version) || decision.version < 1 || decision.version < latestCtaVersion || location.pathname !== decision.pathname || !Array.isArray(decision.mappings) || decision.mappings.length > 100) return;
        const original = new URL(decision.original);
        if (!['http:', 'https:'].includes(original.protocol) || original.origin !== decision.original || original.origin === location.origin || (!(['localhost','127.0.0.1'].includes(original.hostname) && ['localhost','127.0.0.1'].includes(location.hostname)) && !(operationalContextMatches(decision) && decision.operationalContext.original===original.origin))) return;
        const mappings = new Map();
        const external = decision.externalDestinations ?? [];
        if (!Array.isArray(external) || external.length > 100 || external.some(url => typeof url !== 'string' || url.length > 2048)) return;
        for (const row of decision.mappings) {
          if (!row || typeof row.marker !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(row.marker) || (row.surface !== undefined && (typeof row.surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.surface))) || !['a','form','button'].includes(row.kind) || row.kind==='button' && (typeof discoverCtas==='undefined' || !row.nativeDigest) || typeof row.destination !== 'string') return;
          const target = new URL(row.destination);
          if ((target.origin !== original.origin && (target.protocol !== 'https:' || !external.includes(target.href))) || target.username || target.password || (!row.nativeDigest && target.hash) || !['http:', 'https:'].includes(target.protocol)) return;
          if (row.nativeDigest !== undefined && (!/^[a-f0-9]{64}$/.test(row.nativeDigest) || target.protocol!=='https:')) return;
          const entries = mappings.get(row.marker) || [];
          if (entries.some(item => item.surface === row.surface)) return;
          if (row.requiresSurface !== undefined && typeof row.requiresSurface !== 'boolean') return;
          entries.push({surface:row.surface, requiresSurface:row.requiresSurface, kind:row.kind, nativeDigest:row.nativeDigest, destination:attributed(target.href, decision.attribution)}); mappings.set(row.marker, entries);
        }
        if (!validContext() || Date.now() < startedWall || Date.now() - startedWall > 5000 || performance.now() - startedMono > 5000) return;
        latestCtaVersion = decision.version;
        activeCtas = {receipt:decision.observationReceipt,mappings, pathname:decision.pathname, startedWall, startedMono, checked:new WeakMap()};
        if (decision.mappings.some(row=>row.nativeDigest)) {
          watchNativeLinks();
          checkNativeLinks();
        }
        if (!listenerInstalled) { listenerInstalled = true; install(); }
      } catch (_) { /* Keep original links. */ }
    };
    const entryFor = (node,mappings) => {
      const entries = mappings.get(node.getAttribute('data-anticlone-point') ?? describe(node)?.marker) || [];
      const scope = node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface');
      if (scope) return entries.find(item => item.surface === scope);
      const fallback = entries.filter(item => !item.requiresSurface);
      return fallback.length === 1 ? fallback[0] : null;
    };
    const describe = node => typeof discoverCtas === 'undefined' ? null : discoverCtas.describe(node);
    const selector = typeof discoverCtas === 'undefined' ? 'a[data-anticlone-point][href]' : discoverCtas.selector;
    const commercialLink = node => node.matches('[data-anticlone-price-minor],[data-anticlone-currency],[data-anticlone-offer]');
    const checkNativeLinks = () => {
      const snapshot = activeCtas;
      if (!snapshot || !validContext() || !crypto.subtle) return;
      const nodes = typeof discoverCtas === 'undefined'
        ? document.querySelectorAll(selector)
        : discoverCtas.collect().filter(item=>item.unique && item.point.compatible).map(item=>item.node);
      if (nodes.length > 1000) return;
      for (const node of nodes) {
        const entry = entryFor(node,snapshot.mappings), href = describe(node)?.href ?? node.href;
        if (!entry?.nativeDigest || !href || href.length > 2048 || commercialLink(node)) continue;
        const cached = snapshot.checked.get(node);
        if (cached?.href === href && cached.entry === entry) continue;
        const check = {href,entry,valid:false};
        snapshot.checked.set(node,check);
        void crypto.subtle.digest('SHA-256',new TextEncoder().encode(href)).then(hash=>{
          const digest = Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
          check.valid = digest === entry.nativeDigest;
        }).catch(()=>{});
      }
    };
    let watchingNative = false, nativeFrame = false;
    const watchNativeLinks = () => {
      if (watchingNative) return;
      watchingNative = true;
      const observer = new MutationObserver(() => {
        if (!activeCtas || nativeFrame) return;
        nativeFrame = true;
        requestAnimationFrame(() => { nativeFrame = false; checkNativeLinks(); });
      });
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,
        attributeFilter:typeof discoverCtas !== 'undefined' ? discoverCtas.attributes : ['href','data-anticlone-point','data-anticlone-surface','data-anticlone-price-minor','data-anticlone-currency','data-anticlone-offer']});
    };
    const install = () => {
          document.addEventListener('click', event => {
            try {
              if (!(event.target instanceof Element)) return;
              const node = event.target.closest(selector);
              if (!node || !node.isConnected) return;
              const activate = currentEvent => {
                if (currentEvent !== event) return;
                try {
                  const snapshot = activeCtas;
                  if (!snapshot || Date.now() < snapshot.startedWall || Date.now() - snapshot.startedWall >= ctaTtlMs || performance.now() - snapshot.startedMono >= ctaTtlMs) { activeCtas = null; return; }
                  if (event.defaultPrevented || !validContext() || location.pathname !== snapshot.pathname || !node.isConnected) return;
                  const point = describe(node);
                  const marker = node.getAttribute('data-anticlone-point') ?? point?.marker;
                  const scope = node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface');
                  const entry = entryFor(node,snapshot.mappings);
                  if (!entry || entry.kind !== (node instanceof HTMLAnchorElement ? 'a' : 'button')) return;
                  const current = Array.from(document.querySelectorAll(marker?.startsWith('auto-') ? selector : '[data-anticlone-point]'));
                  if (current.length > 1000 || current.filter(item => (item.getAttribute('data-anticlone-point') ?? describe(item)?.marker) === marker && (!scope || item.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface') === scope)).length !== 1) return;
                  const previous = node.getAttribute('href');
                  if (entry.nativeDigest) {
                    const checked = snapshot.checked.get(node);
                    if (!checked?.valid || checked.entry !== entry || checked.href !== (point?.href ?? node.href) || commercialLink(node) || point && !point.compatible) return;
                  }
                  const replacement = entry.destination;
                  if (point?.navigation) {
                    if (!entry.nativeDigest || !event.isTrusted || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    reportAction(snapshot.receipt, marker, entry.surface ?? null);
                    location.assign(replacement);
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return;
                  }
                  if (!(node instanceof HTMLAnchorElement) || previous===null) return;
                  node.setAttribute('href', replacement);
                  if (event.isTrusted) reportAction(snapshot.receipt, marker, entry.surface ?? null);
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
    core.src = new URL(distribution?.paths?.['core.js'] ?? 'core.js', distribution ? distribution.bases.SCRIPT : source).href;
    core.async = true;
    if (typeof discoverCtas !== 'undefined') core.dataset.acCta = '2';
    // The deadline starts in the bootstrap. Core only collects observations.
    const startDecision = () => {
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
        let restoredFromHistory = false;
        const refresh = (onReturn = false, afterEntry = false) => {
          const elapsed = Date.now() - lastAttempt;
          if (!validContext() || document.hidden || inFlight || elapsed < 0) return;
          // BFCache invalidates the previous snapshot even on a quick return.
          // Keep the failure backoff, but skip the normal cooldown after a successful visit.
          const delay = failed ? backoff : restoredFromHistory ? 0 : onReturn && expired() ? 5000 : refreshIntervalMs;
          if (!afterEntry && elapsed < delay) {
            if (onReturn && expired() && !returnTimer) returnTimer = setTimeout(() => { returnTimer = undefined; refresh(true); }, delay - elapsed);
            return;
          }
          if (returnTimer) { clearTimeout(returnTimer); returnTimer = undefined; }
          restoredFromHistory = false;
          inFlight = true; const id = ++sequence, wall = Date.now(), mono = performance.now(); lastAttempt = wall;
          controller = new AbortController();
          const requestController = controller, timeout = setTimeout(() => requestController.abort(), 5000);
          fetch(endpoint('cta-refresh'), {method:'POST', headers:{'Content-Type':scoped ? 'text/plain;ac-cta=1'+discoveryVersion : 'text/plain'}, body:JSON.stringify({session,signals,pathname:initialPath}), cache:'no-store', signal:requestController.signal})
            .then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); })
            .then(decision => { if (id !== sequence || !validContext()) return; failed = false; backoff = refreshIntervalMs; activeCtas = null; observeCtaVersion(decision); if (decision && decision.action === 'REPLACE_CONVERSION') prepareCtas(decision, wall, mono); })
            .catch(() => { if (id === sequence) { activeCtas = null; failed = true; backoff = Math.min(backoff * 2, 240000); } })
            .finally(() => { clearTimeout(timeout); if (id === sequence) { inFlight = false; controller = undefined; } });
        };
        suspendCtas = () => { restoredFromHistory = false; activeCtas = null; ++sequence; if (controller) controller.abort(); if (returnTimer) clearTimeout(returnTimer); returnTimer = undefined; inFlight = false; controller = undefined; };
        resumeCtas = (fromHistory = false) => {
          restoredFromHistory = fromHistory;
          refresh(true);
        };
        const timer = setInterval(() => refresh(), refreshIntervalMs);
        addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(timer); suspendCtas(); } });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
        const entryWall = Date.now(), entryMono = performance.now(), entrySequence = sequence;
        if (scoped && location.protocol==='https:') visit=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
        fetch(endpoint('entry-decision'), { method:'POST', headers:{'Content-Type':visit ? 'text/plain;ac-visit='+visit+';ac-cta=1'+discoveryVersion : 'text/plain'}, body:JSON.stringify({session,signals,pathname:initialPath}), cache: 'no-store', credentials:'omit', priority:'high' })
          .then(response => { if (!response.ok) throw new Error('decision unavailable'); return response.json(); })
          .then(decision => {
            if (!validContext()) return;
            if (entrySequence === sequence) observeCtaVersion(decision);
            if (decision.action === 'REPLACE_CONVERSION') {
              redirectPending = false; releaseGate();
              if (entrySequence === sequence) prepareCtas(decision, entryWall, entryMono);
              return;
            }
            if (decision.action !== 'PAGE_REDIRECT') {
              if (decision.action!=='OBSERVE_ONLY') reportEntry('RUNTIME_ERROR');
              redirectPending = false; releaseGate(); return;
            }
            if (!redirectPending || redirectInteracted || performance.now() >= deadline) {
              if (!redirectInteracted) reportEntry('LATE_REDIRECT');
              if (entrySequence === sequence) refresh(false, true);
              return;
            }
            if (!Number.isSafeInteger(decision.version) || decision.version < 1 || typeof decision.destination !== 'string' ||
                (decision.operationalContext && !operationalContextMatches(decision))) { cancelRedirect('INVALID_REDIRECT'); return; }
            const target = new URL(decision.destination);
            if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && !decision.operationalContext && ['localhost','127.0.0.1'].includes(target.hostname))) || target.username || target.password || target.href === location.href || target.origin === location.origin) {
              cancelRedirect('INVALID_REDIRECT'); return;
            }
            const destination = attributed(target.href, decision.attribution);
            if (!redirectPending || redirectInteracted || performance.now() >= deadline) {
              reportEntry('LATE_REDIRECT');
              if (entrySequence === sequence) refresh(false,true);
              return;
            }
            handoffElapsed = Math.round(performance.now()-started);
            location.replace(destination);
            redirectPending = false;
            reportEntry('REDIRECT_HANDOFF');
            reportAction(decision.observationReceipt, null, null);
          }).catch(() => { reportEntry('RUNTIME_ERROR'); cancelRedirect(); });
        if (scoped) observe('observed-session', {session,signals,
          ...(initialPath.length <= 384 ? {pathname:initialPath} : {})});
      } catch (_) { cancelRedirect(); }
    };
    startDecision();
    document.head.appendChild(core);
  } catch (_) { /* Leave the page operational. */ }
})();
