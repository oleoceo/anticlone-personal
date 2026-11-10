(() => {
  try {
    const distribution = null;
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const scoped = !!distribution || new URL(source).pathname.startsWith('/i/');
    fetch(new URL(distribution?.paths?.['observe/fallback'] ?? 'observe/fallback', distribution ? distribution.bases.TELEMETRY : source).href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: scoped ? JSON.stringify({origin:location.origin,pathname:location.pathname}) : location.origin, keepalive: true
    }).catch(() => {});
  } catch (_) { /* Observation is best effort. */ }
})();
