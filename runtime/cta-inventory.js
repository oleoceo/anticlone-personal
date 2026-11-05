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
      // Synthetic laboratory content only: short visual context, never an identity signal.
      const context = (node.textContent || '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 160);
      const amount = node.getAttribute('data-anticlone-price-minor');
      const currency = node.getAttribute('data-anticlone-currency');
      const commercial = amount !== null && /^(0|[1-9][0-9]{0,14})$/.test(amount) && currency !== null && /^[A-Z]{3}$/.test(currency) ? {amount:Number(amount), currency} : null;
      return {marker, kind, parent: node.parentElement?.tagName.toLowerCase() || 'none', ordinal: index + 1, url, context, commercial};
    });
  };
})();
