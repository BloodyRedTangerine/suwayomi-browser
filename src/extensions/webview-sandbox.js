// Loaded ONLY as a manifest-declared opaque sandbox page (Firefox 154+).
// No imports, extension APIs, direct network or same-origin access are allowed.
(() => {
  'use strict';
  const key = decodeURIComponent(location.hash.slice(1));
  const origin = `${location.protocol}//${location.host}`;
  if (!key || typeof globalThis.chrome?.runtime !== 'undefined' || typeof globalThis.browser?.runtime !== 'undefined')
    throw new Error('WebView must run without extension APIs in its declared sandbox.');
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== origin || !data || data.key !== key
      || data.type !== 'loadDocument' || typeof data.html !== 'string') return;
    try {
      document.open(); document.write(data.html); document.close();
      parent.postMessage({ key, type: 'documentWritten' }, '*');
    } catch (error) {
      parent.postMessage({ key, type: 'bootstrapError', message: String(error?.message || error) }, '*');
    }
  });
  parent.postMessage({ key, type: 'bootstrapReady', declaredSandbox: true, extensionAPIs: false }, '*');
})();
