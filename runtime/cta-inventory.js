// Passive, bounded snapshot for operator-assisted laboratory import. No network or DOM writes.
(() => {
  window.anticloneLabInventory = () => {
    if (!['localhost', '127.0.0.1'].includes(location.hostname) || !['http:', 'https:'].includes(location.protocol)) throw new Error('laboratory only');
    const nodes = Array.from(document.querySelectorAll('a[href], form[action], button'));
    if (nodes.length > 100) throw new Error('inventory limit exceeded');
    return nodes.map((node, index) => {
      const marker = node.getAttribute('data-anticlone-point');
      const kind = node.tagName.toLowerCase();
      const raw = kind === 'a' ? node.getAttribute('href') : kind === 'form' ? node.getAttribute('action') : null;
      let url = null;
      if (raw) {
        try { const parsed = new URL(raw, document.baseURI); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { parsed.search = ''; parsed.hash = ''; url = parsed.href; } } catch (_) { /* unobservable destination */ }
      }
      // Ordinal is a temporary locator, never identity. No text, price, value or selectors are collected.
      return {marker, kind, parent: node.parentElement?.tagName.toLowerCase() || 'none', ordinal: index + 1, url};
    });
  };
})();
