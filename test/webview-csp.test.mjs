import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authorizeGeneratedInlineScripts, isCspRequestAllowed, snapshotContentSecurityPolicies, upgradeInsecureRequestUrl } from '../src/extensions/webview-csp.mjs';

const baseUrl = 'https://reader.example.test/page';
const allowed = (policies, resourceUrl, directive, options) => isCspRequestAllowed({
  policies, baseUrl, resourceUrl, directive, ...options,
});

test('WebView CSP uses destination-specific directives and the correct fallback chain', () => {
  const policies = ["default-src 'none'; script-src https://cdn.example.test; style-src 'self'; img-src https://images.example.test"];
  assert.equal(allowed(policies, 'https://cdn.example.test/app.js', 'script-src-elem'), true);
  assert.equal(allowed(policies, 'https://cdn.example.test/app.css', 'style-src-elem'), false);
  assert.equal(allowed(policies, 'https://reader.example.test/app.css', 'style-src-elem'), true);
  assert.equal(allowed(policies, 'https://images.example.test/cover.png', 'img-src'), true);
  assert.equal(allowed(policies, 'https://images.example.test/cover.png', 'font-src'), false);
  assert.equal(allowed(["default-src 'none'; script-src-elem https://cdn.example.test"], 'https://cdn.example.test/app.js', 'script-src-elem'), true);
  assert.equal(allowed(["default-src 'none'; script-src-elem https://cdn.example.test"], 'https://cdn.example.test/app.js', 'script-src'), false);
  assert.equal(allowed([], 'https://any.example.test/a', 'connect-src'), true);
  assert.equal(allowed(["default-src 'none'"], 'https://any.example.test/a', 'unknown-src'), false);
});

test('WebView CSP intersects policies, honors self/scheme/host/port/path sources, and ignores duplicate directives after the first', () => {
  assert.equal(allowed(["connect-src 'self'"], baseUrl, 'connect-src'), true);
  assert.equal(allowed(["connect-src 'self'"], 'https://other.example.test/', 'connect-src'), false);
  assert.equal(allowed(["connect-src https:"], 'https://other.example.test/', 'connect-src'), true);
  assert.equal(allowed(["connect-src http:"], 'https://other.example.test/', 'connect-src'), true, 'CSP permits a secure upgrade from http:');
  assert.equal(allowed(["connect-src *.example.test"], 'https://cdn.example.test/', 'connect-src'), true);
  assert.equal(allowed(["connect-src *.example.test"], 'https://example.test/', 'connect-src'), false);
  assert.equal(allowed(["connect-src https://cdn.example.test/assets/"], 'https://cdn.example.test/assets/a.js', 'connect-src'), true);
  assert.equal(allowed(["connect-src https://cdn.example.test/assets/"], 'https://cdn.example.test/elsewhere.js', 'connect-src'), false);
  assert.equal(allowed(["connect-src https://cdn.example.test:8443"], 'https://cdn.example.test:8443/a', 'connect-src'), true);
  assert.equal(allowed(["connect-src https://cdn.example.test:8443"], 'https://cdn.example.test/a', 'connect-src'), false);
  assert.equal(allowed(["connect-src https://cdn.example.test", "connect-src 'self'"], 'https://cdn.example.test/a', 'connect-src'), false);
  assert.equal(allowed(["connect-src 'none' https://cdn.example.test"], 'https://cdn.example.test/a', 'connect-src'), true);
  assert.equal(allowed(["connect-src 'none'; connect-src *"], 'https://cdn.example.test/a', 'connect-src'), false);
});

test('WebView CSP external script exceptions require matching nonce or integrity metadata', () => {
  const noncePolicy = ["script-src 'nonce-abc123' 'strict-dynamic'"];
  assert.equal(allowed(noncePolicy, 'https://blocked.example.test/app.js', 'script-src-elem', { nonce: 'abc123' }), true);
  assert.equal(allowed(noncePolicy, 'https://blocked.example.test/app.js', 'script-src-elem', { nonce: 'wrong' }), false);
  assert.equal(allowed(["script-src 'strict-dynamic' https://cdn.example.test"], 'https://cdn.example.test/app.js', 'script-src-elem'), false);
  assert.equal(allowed(["script-src 'sha384-AbCd123='"], 'https://blocked.example.test/app.js', 'script-src-elem', { integrity: 'sha384-AbCd123=' }), true);
  assert.equal(allowed(["script-src 'sha384-AbCd123='"], 'https://blocked.example.test/app.js', 'script-src-elem', { integrity: 'sha384-other=' }), false);
});

test('WebView CSP meta policies apply only to document elements after the meta', () => {
  const before = { tagName: 'SCRIPT', getAttribute: () => null };
  const meta = { tagName: 'META', getAttribute: name => name === 'http-equiv' ? 'Content-Security-Policy' : "img-src 'none'" };
  const after = { tagName: 'IMG', getAttribute: () => null };
  const snapshot = snapshotContentSecurityPolicies({ querySelectorAll: () => [before, meta, after] });
  assert.deepEqual(snapshot.policiesByElement.get(before), []);
  assert.deepEqual(snapshot.policiesByElement.get(after), ["img-src 'none'"]);
  assert.deepEqual(snapshot.policies, ["img-src 'none'"]);
});

test('generated WebView inline scripts receive exact hashes without weakening source CSP', async () => {
  const meta = content => ({
    content,
    getAttribute(name) { return name === 'http-equiv' ? 'Content-Security-Policy' : this.content; },
    setAttribute(name, value) { if (name === 'content') this.content = value; },
  });
  const strict = meta("default-src 'none'; script-src 'self' 'nonce-probe' https://cdn.example.test; style-src 'self'");
  const elemOnly = meta("script-src-elem 'self'; script-src 'none'");
  const inlineAllowed = meta("script-src 'unsafe-inline'");
  const inlineWithInvalidNonce = meta("script-src 'unsafe-inline' 'nonce-@@'");
  const document = { querySelectorAll: () => [strict, elemOnly, inlineAllowed, inlineWithInvalidNonce] };
  const generated = ['window.marker=true;', 'window.code=2;'];
  const hashes = await authorizeGeneratedInlineScripts(document, generated, webcrypto);
  const expected = await Promise.all(generated.map(async script => {
    const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(script)));
    return `'sha256-${Buffer.from(digest).toString('base64')}'`;
  }));

  assert.deepEqual(hashes, expected);
  for (const hash of expected) {
    assert.ok(strict.content.includes(hash));
    assert.ok(elemOnly.content.includes(hash));
    assert.ok(!inlineAllowed.content.includes(hash));
    assert.ok(!inlineWithInvalidNonce.content.includes(hash));
  }
  assert.match(strict.content, /script-src 'self' 'nonce-probe' https:\/\/cdn\.example\.test 'sha256-/);
  assert.doesNotMatch(strict.content, /'unsafe-inline'/);
  assert.match(elemOnly.content, /script-src 'none'/, 'duplicate later directives stay untouched');
  assert.equal(inlineAllowed.content, "script-src 'unsafe-inline'", 'an existing unsafe-inline-only policy is preserved');
  assert.equal(inlineWithInvalidNonce.content, "script-src 'unsafe-inline' 'nonce-@@'", 'invalid nonce text does not change unsafe-inline semantics');
});

test('generated script hashes use default-src fallback and amend only the first duplicate directive', async () => {
  const defaultPolicy = {
    content: "default-src 'none'",
    getAttribute(name) { return name === 'http-equiv' ? 'content-security-policy' : this.content; },
    setAttribute(name, value) { if (name === 'content') this.content = value; },
  };
  const duplicatePolicy = {
    content: "script-src 'self'; script-src 'none'",
    getAttribute(name) { return name === 'http-equiv' ? 'content-security-policy' : this.content; },
    setAttribute(name, value) { if (name === 'content') this.content = value; },
  };
  const generated = 'window.onlyThisGeneratedScript=true;';
  const [hash] = await authorizeGeneratedInlineScripts({ querySelectorAll: () => [defaultPolicy, duplicatePolicy] }, [generated], webcrypto);
  assert.equal(defaultPolicy.content, `default-src 'none' ${hash}`);
  assert.equal(duplicatePolicy.content, `script-src 'self' ${hash}; script-src 'none'`);
});

test('CSP upgrade-insecure-requests upgrades HTTP URLs before source matching', () => {
  const policies = ["img-src https:; upgrade-insecure-requests"];
  assert.equal(upgradeInsecureRequestUrl(policies, 'http://cdn.example.test:80/cover.png'), 'https://cdn.example.test/cover.png');
  assert.equal(upgradeInsecureRequestUrl(policies, 'http://cdn.example.test:8080/cover.png'), 'https://cdn.example.test:8080/cover.png');
  assert.equal(upgradeInsecureRequestUrl(policies, 'https://cdn.example.test/cover.png'), 'https://cdn.example.test/cover.png');
  assert.equal(upgradeInsecureRequestUrl(['img-src https:'], 'http://cdn.example.test/cover.png'), 'http://cdn.example.test/cover.png');
  assert.equal(allowed(policies, upgradeInsecureRequestUrl(policies, 'http://cdn.example.test/cover.png'), 'img-src'), true);
  assert.equal(allowed(policies, 'http://cdn.example.test/cover.png', 'img-src'), false);
});

test('WebView upgrades runtime and pre-document requests before CSP checks and broker dispatch', async () => {
  const { BrowserWebViewHost } = await import('../src/extensions/webview.mjs');
  const host = new BrowserWebViewHost();
  await host.handle({ action: 'create', session: 'csp-upgrade' });
  const session = host.sessions.get('csp-upgrade');
  session.documentBaseUrl = baseUrl;
  session.cspPolicies = ['connect-src https://reader.example.test; upgrade-insecure-requests'];
  const frame = { contentWindow: { postMessage() {} } };
  session.iframe = frame;
  session.onMessage({ source: frame.contentWindow, data: {
    key: session.key, type: 'resourceRequest', request: { id: 'runtime', url: 'http://reader.example.test/api', cspDirective: 'connect-src' },
  } });
  assert.equal((await session.nextEvent()).url, 'https://reader.example.test/api');

  const pending = session.requestPageResource('http://reader.example.test/static', baseUrl, { cspDirective: 'connect-src' });
  const request = await session.nextEvent();
  assert.equal(request.url, 'https://reader.example.test/static');
  session.completeResource({ resourceId: request.id, response: { status: 200, headers: [], body: '' } });
  const response = await pending;
  assert.equal(response.url, 'https://reader.example.test/static');
  host.sessions.clear();
});

test('WebView host refuses CSP-denied broker requests and stops blocked redirect hops', async () => {
  const { BrowserWebViewHost } = await import('../src/extensions/webview.mjs');
  const host = new BrowserWebViewHost();
  await host.handle({ action: 'create', session: 'csp-runtime' });
  const session = host.sessions.get('csp-runtime');
  session.documentBaseUrl = baseUrl;
  session.cspPolicies = ["connect-src 'self'"];
  const posted = [];
  session.iframe = { contentWindow: { postMessage: message => posted.push(message) } };
  session.onMessage({ source: session.iframe.contentWindow, data: {
    key: session.key, type: 'resourceRequest', request: { id: 'denied', url: 'https://blocked.example.test/data', cspDirective: 'connect-src' },
  } });
  assert.equal(session.events.length, 0);
  assert.equal(posted[0].type, 'resourceComplete');
  assert.match(posted[0].error, /Content Security Policy/);

  const pending = session.requestPageResource('https://reader.example.test/allowed', baseUrl, { cspDirective: 'connect-src' });
  const first = await session.nextEvent();
  assert.equal(first.url, 'https://reader.example.test/allowed');
  session.completeResource({ resourceId: first.id, response: {
    status: 302, headers: [['Location', 'https://blocked.example.test/redirected']], body: '',
  } });
  const redirected = await pending;
  assert.equal(redirected.blockedByCsp, true);
  assert.equal(session.events.length, 0, 'a redirect denied by CSP is never sent to the broker');
  host.sessions.clear();
});
