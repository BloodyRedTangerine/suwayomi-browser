// Chromium source manifest stays untouched. Firefox identity is user-chosen.
export const FIREFOX_ID = 'suwayomi-browser@bloodyredtangerine';

export function targetManifest(source, target = 'chrome') {
  if (!['chrome', 'firefox'].includes(target)) throw new Error('Unknown extension target: ' + target);
  const manifest = structuredClone(source);
  if (target === 'chrome') return manifest;
  manifest.name = 'Suwayomi Browser (unofficial)';
  manifest.homepage_url = 'https://github.com/BloodyRedTangerine/suwayomi-browser';
  delete manifest.key;
  manifest.background = { scripts: ['extension-background.mjs'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: { id: FIREFOX_ID, strict_min_version: '154.0', data_collection_permissions: { required: ['none'] } },
    gecko_android: { strict_min_version: '154.0' },
  };
  // Firefox inherits privileged CSP into data/srcdoc/blob URLs. Firefox 154+
  // declared sandbox pages retain opaque isolation with a separate CSP.
  manifest.sandbox = { pages: ['src/extensions/webview-sandbox.html'] };
  manifest.content_security_policy.sandbox = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; worker-src blob:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
  // Measured host-scoped DNR works: do not add webRequestBlocking or feedback.
  return manifest;
}
