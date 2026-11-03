(() => {
  try {
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const deadline = performance.now() + 150;
    let pending = true;
    const cancel = () => { pending = false; };
    setTimeout(cancel, 150);
    addEventListener('pagehide', cancel, {once:true});
    addEventListener('beforeunload', cancel, {once:true});
    addEventListener('pointerdown', cancel, {once:true, capture:true});
    addEventListener('keydown', cancel, {once:true, capture:true});
    const core = document.createElement('script');
    core.src = new URL('/core.js', source).href;
    core.async = true;
    core.onload = () => {
      if (!pending || performance.now() >= deadline) return;
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
        fetch(new URL('/entry-decision', source).href, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({session,signals}), cache: 'no-store' })
          .then(response => { if (!response.ok) throw new Error('decision unavailable'); return response.json(); })
          .then(decision => {
            if (!pending || performance.now() >= deadline) return;
            pending = false;
            if (decision.action !== 'PAGE_REDIRECT' || !Number.isSafeInteger(decision.version) || decision.version < 1 || typeof decision.destination !== 'string') return;
            const target = new URL(decision.destination);
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || target.href === location.href || target.origin === location.origin) return;
            location.replace(target.href);
          }).catch(cancel);
      } catch (_) { cancel(); }
    };
    document.head.appendChild(core);
  } catch (_) { /* Leave the page operational. */ }
})();
