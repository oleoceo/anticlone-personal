(() => {
  try {
    const source = document.currentScript && document.currentScript.src;
    if (!source) return;
    const core = document.createElement('script');
    core.src = new URL('/core.js', source).href;
    core.async = true;
    document.head.appendChild(core);
  } catch (_) { /* Leave the page operational. */ }
})();
