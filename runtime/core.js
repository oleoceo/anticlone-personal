(() => {
  try {
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
    const scoped = new URL(source).pathname.startsWith('/i/');
    fetch(new URL('observe', source).href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(scoped ? {origin: location.origin, pathname: location.pathname, signals} : {origin: location.origin, signals}), keepalive: true
    }).catch(() => {});
  } catch (_) { /* Observation is best effort. */ }
})();
