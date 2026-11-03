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
        fetch(new URL('/entry-decision', source).href, { cache: 'no-store' })
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
