(() => {
  try {
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const scoped = new URL(source).pathname.startsWith('/i/');
    fetch(new URL('observe/fallback', source).href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: scoped ? JSON.stringify({origin:location.origin,pathname:location.pathname}) : location.origin, keepalive: true
    }).catch(() => {});
  } catch (_) { /* Observation is best effort. */ }
})();
