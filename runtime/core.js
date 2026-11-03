(() => {
  try {
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    fetch(new URL('/observe', source).href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: location.origin, keepalive: true
    }).catch(() => {});
  } catch (_) { /* Observation is best effort. */ }
})();
