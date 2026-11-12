// Passive, bounded snapshot for operator-assisted laboratory import. No network or DOM writes.
(() => {
  window.anticloneLabInventory = (surface) => {
    if (!['localhost', '127.0.0.1'].includes(location.hostname) || !['http:', 'https:'].includes(location.protocol)) throw new Error('laboratory only');
    if (surface !== undefined && (typeof surface !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(surface))) throw new Error('invalid surface');
    const nodes = Array.from(document.querySelectorAll('a[href], form[action], button')).filter(node => surface === undefined || node.closest('[data-anticlone-surface]')?.getAttribute('data-anticlone-surface') === surface);
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
      let commercial = amount !== null && /^(0|[1-9][0-9]{0,14})$/.test(amount) && currency !== null && /^[A-Z]{3}$/.test(currency) ? {amount:Number(amount), currency} : null;
      // Explicit structured declarations only. Invalid/missing fields stay UNKNOWN.
      const minor = name => { const value=node.getAttribute(name); return value !== null && /^(0|[1-9][0-9]{0,14})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null; };
      const offer=node.getAttribute('data-anticlone-offer');
      const count=minor('data-anticlone-installments'), installment=minor('data-anticlone-installment-minor'), discount=minor('data-anticlone-discount-bps');
      const termNames=['data-anticlone-offer','data-anticlone-previous-minor','data-anticlone-installments','data-anticlone-installment-minor','data-anticlone-discount-bps'];
      if (commercial && termNames.some(name=>node.hasAttribute(name))) commercial.terms={offer:offer !== null && /^[a-zA-Z0-9_-]{1,64}$/.test(offer) ? offer : null,previousAmount:minor('data-anticlone-previous-minor'),discountBps:discount !== null && discount <= 10000 ? discount : null,installments:count !== null && count >= 1 && count <= 360 && installment !== null ? {count,amount:installment} : null};
      return {marker, kind, parent: node.parentElement?.tagName.toLowerCase() || 'none', ordinal: index + 1, url, context, commercial};
    });
  };
})();
