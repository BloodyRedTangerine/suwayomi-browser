import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionOrigin, extensionHost, isOwnBackgroundRequest, headersReceivedExtraInfo,
  dnrInitiatorDomains, supportsBlockingWebRequest, checkExactHeaderRegex } from '../src/extensions/platform.mjs';
import { targetManifest, FIREFOX_ID } from '../scripts/target-manifest.mjs';
import { hostPermissionOrigin, observedResponseHeaders, sandboxWebViewBootstrap } from '../src/extensions/platform.mjs';
import { permissionPattern, sourcePermissionOrigins, artifactPermissionOrigins } from '../src/extensions/permissions.mjs';

for (const scheme of ['chrome-extension', 'moz-extension']) {
  const host = scheme === 'moz-extension' ? '8c6e2ac4-1d95-46d7-b59a-888340959643' : 'chromium-id';
  const api = { runtime: { id: scheme === 'moz-extension' ? FIREFOX_ID : host,
    getURL: path => `${scheme}://${host}/${path}`, getManifest: () => ({ permissions: [] }) },
    webRequest: scheme === 'chrome-extension' ? { OnHeadersReceivedOptions: { EXTRA_HEADERS: 'extraHeaders' } } : {} };
  test(`${scheme} origin derives from getURL, not runtime.id or Node URL.origin`, () => {
    assert.equal(extensionOrigin(api), `${scheme}://${host}`);
    assert.equal(extensionHost(api), host);
    assert.deepEqual(dnrInitiatorDomains(api), [host]);
    assert.equal(supportsBlockingWebRequest(api), false);
    assert.equal(sandboxWebViewBootstrap('fixture-key', api), null);
    assert.deepEqual(headersReceivedExtraInfo(api), scheme === 'chrome-extension' ? ['responseHeaders', 'extraHeaders'] : ['responseHeaders']);
  });
  test(`${scheme} match-pattern ports use measured platform support without changing request URL`, () => {
    for (const raw of ['http://127.0.0.1:4188/page', 'http://localhost:4188/page', 'http://[::1]:4188/page', 'https://source.test:8443/page']) {
      const url = new URL(raw), original = url.href;
      const origin = `${url.protocol}//${scheme === 'moz-extension' ? url.hostname : url.host}`;
      assert.equal(hostPermissionOrigin(url, api), origin);
      assert.equal(permissionPattern(raw, api), origin + '/*');
      assert.equal(url.href, original);
    }
  });
  test(`${scheme} owns only matching background event origins and fails closed`, () => {
    for (const field of ['initiator', 'originUrl', 'documentUrl']) {
      const event = { tabId: -1, [field]: `${scheme}://${host}/background.mjs` };
      assert.equal(isOwnBackgroundRequest(event, api), true);
      assert.equal(isOwnBackgroundRequest({ ...event, tabId: 2 }, api), false);
      assert.equal(isOwnBackgroundRequest({ ...event, [field]: `${scheme}://foreign/background.mjs` }, api), false);
    }
    for (const from of ['null', '', '::::', 'https://source.test/', `${scheme}://user:pass@${host}/`])
      assert.equal(isOwnBackgroundRequest({ tabId: -1, originUrl: from }, api), false);
    assert.equal(isOwnBackgroundRequest({ tabId: -1 }, api), false);
    assert.equal(isOwnBackgroundRequest({ tabId: -1, initiator: 'https://foreign.test', originUrl: `${scheme}://${host}/` }, api), false);
  });
}

test('Header regex capability is detected and unavailable/unsupported scope fails closed', async () => {
  await assert.rejects(checkExactHeaderRegex({}, '^x$'), /verify exact/);
  await assert.rejects(checkExactHeaderRegex({ declarativeNetRequest: { isRegexSupported: async () => ({ isSupported: false, reason: 'invalid' }) } }, '^x$'), /safely scope/);
  await checkExactHeaderRegex({ declarativeNetRequest: { isRegexSupported: async value => {
    assert.deepEqual(value, { regex: '^x$', isCaseSensitive: true }); return { isSupported: true };
  } } }, '^x$');
});

test('Firefox newline-joined Set-Cookie fields separate without splitting Expires commas', () => {
  const one = 'a=one; Expires=Thu, 31 Dec 2037 00:00:00 GMT';
  const two = 'b=two; HttpOnly';
  assert.deepEqual(observedResponseHeaders([{ name: 'Set-Cookie', value: one + '\n' + two },
    { name: 'Content-Type', value: 'text/html' }, { name: 'binary', binaryValue: [1, 2] }]),
  [['Set-Cookie', one], ['Set-Cookie', two], ['Content-Type', 'text/html']]);
  assert.deepEqual(observedResponseHeaders([{ name: 'Set-Cookie', value: one }, { name: 'set-cookie', value: two }]),
    [['Set-Cookie', one], ['set-cookie', two]]);
});

test('Firefox source/artifact permission maps preserve canonical host patterns, not map callback indexes', () => {
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => 'moz-extension://fixture/' + path } };
  try {
    assert.deepEqual(sourcePermissionOrigins([{ baseUrl: 'http://127.0.0.1:4188/a' }, { homeUrl: 'https://reader.test:8443/manga' }]),
      ['http://127.0.0.1/*', 'https://reader.test/*']);
    assert.deepEqual(artifactPermissionOrigins(['http://localhost:4188/source.jar']), ['http://localhost/*']);
  } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
});

test('Target manifests lock exact Firefox differences and leave Chromium source unchanged', async () => {
  const source = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const original = structuredClone(source);
  assert.deepEqual(targetManifest(source), original);
  assert.deepEqual(targetManifest(source, 'chrome'), original);
  const firefox = targetManifest(source, 'firefox');
  const expected = structuredClone(original);
  expected.name = 'Suwayomi Browser (unofficial)';
  expected.homepage_url = 'https://github.com/BloodyRedTangerine/suwayomi-browser';
  delete expected.key;
  expected.background = { scripts: ['extension-background.mjs'], type: 'module' };
  expected.browser_specific_settings = {
    gecko: { id: 'suwayomi-browser@bloodyredtangerine', strict_min_version: '154.0', data_collection_permissions: { required: ['none'] } },
    gecko_android: { strict_min_version: '154.0' },
  };
  expected.sandbox = { pages: ['src/extensions/webview-sandbox.html'] };
  expected.content_security_policy.sandbox = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; worker-src blob:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
  assert.deepEqual(firefox, expected);
  assert.deepEqual(source, original);
  assert.ok(original.key);
  assert.equal(original.browser_specific_settings, undefined);
  assert.equal(original.sandbox, undefined);
  assert.equal(original.content_security_policy.sandbox, undefined);
  assert.equal(firefox.content_security_policy.extension_pages, original.content_security_policy.extension_pages);
  assert.ok(!firefox.content_security_policy.sandbox.includes('allow-same-origin'));
  for (const manifest of [original, firefox]) {
    assert.equal(manifest.host_permissions, undefined);
    assert.ok(!manifest.permissions.includes('webRequestBlocking'));
    assert.ok(!manifest.permissions.includes('declarativeNetRequestFeedback'));
  }
  assert.throws(() => targetManifest(source, 'unknown'), /Unknown extension target/);
});

test('Only the declared isolated WebView bootstrap path is selected; key is URL-encoded', () => {
  const api = { runtime: { getURL: path => 'moz-extension://uuid/' + path,
    getManifest: () => ({ sandbox: { pages: ['src/extensions/webview-sandbox.html'] } }) } };
  assert.equal(sandboxWebViewBootstrap('key/#?&', api), 'moz-extension://uuid/src/extensions/webview-sandbox.html#key%2F%23%3F%26');
});
