import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createObservedFetch, createObservedFetchStream } from '../src/extensions/response-headers.mjs';
import { createSourceBroker } from '../src/extensions/broker.mjs';

for (const platform of ['chrome', 'firefox']) {
const test = (name, ...args) => nodeTest(`${platform}: ${name}`, ...args);
const getURL = function (path) { return (platform === 'firefox' ? 'moz-extension://fixture-uuid/' : `chrome-extension://${this.id}/`) + path; };

function fixture() {
  const event = () => ({
    listeners: new Set(), options: [], failAdd: false, failRemove: false,
    addListener(callback, filter, extra) { if (this.failAdd) throw new Error('add failed'); this.listeners.add(callback); this.options.push({ filter, extra }); },
    removeListener(callback) { if (this.failRemove) throw new Error('remove failed'); this.listeners.delete(callback); },
    emit(details) { for (const listener of this.listeners) listener(details); },
  });
  const browser = { runtime: { id: 'local-test', getURL }, webRequest: { ...(platform === 'chrome' ? { OnHeadersReceivedOptions: { EXTRA_HEADERS: 'extraHeaders' } } : {}), onBeforeRequest: event(), onHeadersReceived: event() } };
  const request = { url: 'https://source.test/Case?key=1', method: 'GET', headers: [] };
  const details = { url: request.url, method: 'GET', type: 'xmlhttprequest', tabId: -1, ...(platform === 'chrome' ? { initiator: 'chrome-extension://local-test' } : { originUrl: 'moz-extension://fixture-uuid/_generated_background_page.html', documentUrl: 'moz-extension://fixture-uuid/_generated_background_page.html' }), requestId: 'own-1' };
  const before = override => browser.webRequest.onBeforeRequest.emit({ ...details, ...override });
  const headers = override => browser.webRequest.onHeadersReceived.emit({ ...details, statusCode: 200, statusLine: 'HTTP/2 200 OK', responseHeaders: [], ...override });
  const response = override => ({ status: 200, statusText: 'OK', url: request.url, headers: [['Content-Type', 'image/png']], body: 'AA==', ...override });
  const empty = () => { for (const value of Object.values(browser.webRequest)) if (value.listeners) assert.equal(value.listeners.size, 0); };
  return { browser, request, before, headers, response, empty };
}

for (const factory of [createObservedFetch, createObservedFetchStream]) {
  test(`${factory.name}: late matching redirect event is accepted only on Firefox`, async () => {
    const f = fixture();
    const observed = factory(f.browser, async () => {
      f.before();
      setTimeout(() => f.headers({ statusCode: 302, responseHeaders: [{ name: 'Location', value: 'https://next.test/' }] }), 10);
      return f.response({ status: 0 });
    });
    if (platform === 'firefox') {
      const result = await observed(f.request);
      assert.equal(result.status, 302);
      assert.deepEqual(result.headers, [['Location', 'https://next.test/']]);
    } else await assert.rejects(observed(f.request), /did not expose/);
    f.empty();
  });
  test(`${factory.name}: abort during metadata wait removes listeners without replay`, async () => {
    const f = fixture(), controller = new AbortController();
    let calls = 0;
    const observed = factory(f.browser, async () => {
      calls++; f.before(); setTimeout(() => controller.abort(), 10); return f.response({ status: 0 });
    });
    await assert.rejects(observed(f.request, { signal: controller.signal }),
      platform === 'firefox' ? /aborted/i : /did not expose/);
    assert.equal(calls, 1); f.empty();
  });
}

test('Response observation preserves separate source Set-Cookie headers without reintroducing wire encodings', async () => {
  const f = fixture();
  const fetch = createObservedFetch(f.browser, async (request, options) => {
    assert.equal(request.url, f.request.url); assert.deepEqual(options, { redirect: 'manual' });
    f.before(); f.headers({ responseHeaders: [
      { name: 'Set-Cookie', value: 'one=dummy; Expires=Thu, 31 Dec 2037 00:00:00 GMT' },
      { name: 'set-cookie', value: 'two=dummy; Secure' }, { name: 'Content-Encoding', value: 'gzip' },
    ] });
    return f.response({ headers: [['Content-Type', 'image/png'], ['Set-Cookie', 'unobserved=discard']] });
  });
  const response = await fetch(f.request);
  assert.deepEqual(response.headers, [['Content-Type', 'image/png'], ['Set-Cookie', 'one=dummy; Expires=Thu, 31 Dec 2037 00:00:00 GMT'], ['set-cookie', 'two=dummy; Secure']]);
  assert.equal(response.body, 'AA==');
  assert.deepEqual(f.browser.webRequest.onHeadersReceived.options[0], { filter: { urls: ['https://source.test/*'], types: ['xmlhttprequest'] }, extra: platform === 'chrome' ? ['responseHeaders', 'extraHeaders'] : ['responseHeaders'] });
  f.empty();
});

test('Unique exact response headers identify a request when the browser omits onBeforeRequest', async () => {
  const f = fixture();
  const fetch = createObservedFetch(f.browser, async () => {
    f.headers({ responseHeaders: [{ name: 'Set-Cookie', value: 'source=dummy; Path=/' }] });
    return f.response({ headers: [['Content-Type', 'image/png']] });
  });
  const response = await fetch(f.request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, [['Content-Type', 'image/png'], ['Set-Cookie', 'source=dummy; Path=/']]);
  f.empty();
});

test('Streamed response observation returns its live body and observed source cookies at headers', async () => {
  const f = fixture();
  const fetch = createObservedFetchStream(f.browser, async (request, options) => {
    assert.equal(request.url, f.request.url);
    assert.deepEqual(options, { redirect: 'manual' });
    f.before();
    f.headers({ responseHeaders: [
      { name: 'Set-Cookie', value: 'stream-one=dummy; Path=/' },
      { name: 'set-cookie', value: 'stream-two=dummy; Secure' },
    ] });
    return { ...f.response({ headers: [['Content-Type', 'text/plain'], ['Set-Cookie', 'unobserved=dummy']] }), body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('second'));
      controller.close();
    } }) };
  });
  const response = await fetch(f.request);
  assert.deepEqual(response.headers, [['Content-Type', 'text/plain'], ['Set-Cookie', 'stream-one=dummy; Path=/'], ['set-cookie', 'stream-two=dummy; Secure']]);
  assert.equal(typeof response.body.getReader, 'function');
  f.empty();
  assert.equal(await new Response(response.body).text(), 'firstsecond');
});

test('Manual opaque redirects use only matching observed metadata and never claim an exposed body', async () => {
  const f = fixture();
  const fetch = createObservedFetch(f.browser, async () => {
    f.before(); f.headers({ statusCode: 302, statusLine: 'HTTP/1.1 302 Found', responseHeaders: [
      { name: 'Location', value: '/next' }, { name: 'Set-Cookie', value: 'source=dummy' },
      { name: 'Content-Length', value: '123' }, { name: 'Content-Encoding', value: 'gzip' },
    ] });
    return f.response({ status: 0, body: '' });
  });
  assert.deepEqual(await fetch(f.request), { status: 302, statusText: 'Found', url: f.request.url, headers: [['Location', '/next'], ['Set-Cookie', 'source=dummy']], body: '' });
  f.empty();
});

test('Observer ignores tab/profile cookies, foreign initiators, other request IDs, methods, types and case-mismatched URLs', async () => {
  const f = fixture();
  const fetch = createObservedFetch(f.browser, async () => {
    for (const override of [{ tabId: 1 }, { initiator: 'https://source.test' }, { type: 'image' }, { method: 'POST' }, { url: f.request.url.toLowerCase() }]) {
      f.before({ ...override, requestId: 'unrelated' });
      f.headers({ ...override, requestId: 'unrelated', responseHeaders: [{ name: 'Set-Cookie', value: 'ambient=must-not-import' }] });
    }
    f.before();
    f.headers({ statusCode: 100, responseHeaders: [{ name: 'Set-Cookie', value: 'interim=must-not-import' }] });
    f.headers({ method: 'POST', responseHeaders: [{ name: 'Set-Cookie', value: 'different-method=must-not-import' }] });
    f.headers({ requestId: 'different', responseHeaders: [{ name: 'Set-Cookie', value: 'ambient=must-not-import' }] });
    f.headers({ responseHeaders: [{ name: 'Set-Cookie', value: 'source=dummy' }] });
    return f.response();
  });
  assert.deepEqual((await fetch(f.request)).headers, [['Content-Type', 'image/png'], ['Set-Cookie', 'source=dummy']]);
  f.empty();
});

test('Missing, ambiguous, opaque nonredirect and mismatched observations fail closed and clean listeners', async () => {
  for (const mode of ['missing', 'ambiguous', 'status', 'url', 'opaque']) {
    const f = fixture();
    const fetch = createObservedFetch(f.browser, async () => {
      if (mode === 'missing') return f.response();
      f.before();
      if (mode === 'ambiguous') f.before({ requestId: 'own-2' });
      f.headers();
      return f.response(mode === 'status' ? { status: 201 } : mode === 'url' ? { url: 'https://other.test/' } : mode === 'opaque' ? { status: 0 } : {});
    });
    await assert.rejects(fetch(f.request), /expose|Ambiguous|match|Opaque/);
    f.empty();
  }
});

test('Header-only observation with conflicting request IDs is rejected as ambiguous', async () => {
  const f = fixture();
  const fetch = createObservedFetch(f.browser, async () => {
    f.headers();
    f.headers({ requestId: 'other-request' });
    return f.response();
  });
  await assert.rejects(fetch(f.request), /Ambiguous source response/);
  f.empty();
});

test('Observer attachment/fetch failures clean up; removal failure disables observers and poisons subsequent requests', async () => {
  const f = fixture();
  f.browser.webRequest.onHeadersReceived.failAdd = true;
  await assert.rejects(createObservedFetch(f.browser, async () => assert.fail('must not fetch'))(f.request), /add failed/); f.empty();
  f.browser.webRequest.onHeadersReceived.failAdd = false;
  await assert.rejects(createObservedFetch(f.browser, async () => { throw new Error('fetch failed'); })(f.request), /fetch failed/); f.empty();
  let calls = 0;
  f.browser.webRequest.onHeadersReceived.failRemove = true;
  const fetch = createObservedFetch(f.browser, async () => { calls++; f.before(); f.headers(); return f.response(); });
  await assert.rejects(fetch(f.request), /cleanup failed/);
  await assert.rejects(fetch(f.request), /cleanup failed/);
  assert.equal(calls, 1);
  // Even the listener that could not be removed has been deactivated.
  f.headers({ responseHeaders: [{ name: 'Set-Cookie', value: 'ambient=not-read' }] });
});

test('Aborting an observed source request propagates its signal and removes scoped listeners', async () => {
  const f = fixture();
  const controller = new AbortController();
  let observedSignal;
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const fetch = createObservedFetch(f.browser, async (_request, options) => new Promise((resolve, reject) => {
    observedSignal = options.signal; begin();
    const abort = () => reject(observedSignal.reason || new DOMException('aborted', 'AbortError'));
    if (observedSignal.aborted) abort(); else observedSignal.addEventListener('abort', abort, { once: true });
  }));
  const pending = fetch(f.request, { signal: controller.signal });
  await started;
  controller.abort(new DOMException('cancel fixture', 'AbortError'));
  await assert.rejects(pending, /cancel fixture/);
  assert.equal(observedSignal.aborted, true);
  f.empty();
});

test('Broker checks each redirect hop host before attaching observers or source-cookie header rules', async () => {
  const f = fixture(), rules = [], hosts = [];
  f.browser.permissions = { contains: async ({ origins }) => { hosts.push(origins[0]); return origins[0] === 'https://source.test/*'; } };
  f.browser.declarativeNetRequest = { getSessionRules: async () => [], isRegexSupported: async () => ({ isSupported: true }), updateSessionRules: async change => rules.push(change) };
  const broker = createSourceBroker(f.browser, createObservedFetch(f.browser, async () => {
    f.before(); f.headers({ statusCode: 302, responseHeaders: [{ name: 'Location', value: 'https://ungranted.test/' }] });
    return f.response({ status: 0 });
  }));
  const run = request => new Promise(resolve => broker({ type: 'suwayomi:fetch', request }, { id: f.browser.runtime.id }, resolve));
  const first = await run({ ...f.request, headers: [['Cookie', 'source=dummy']] });
  assert.equal(first.status, 302); f.empty();
  const count = rules.length;
  const next = await run({ ...f.request, url: 'https://ungranted.test/', headers: [['Cookie', 'must-not-send=dummy']] });
  assert.match(next.error, /Enable source access/);
  assert.equal(rules.length, count); f.empty();
  assert.deepEqual(hosts, ['https://source.test/*', 'https://ungranted.test/*']);
});

test('Default production broker wires browser Fetch to response observation with credentials omitted', async () => {
  const f = fixture();
  f.browser.permissions = { contains: async () => true };
  f.browser.declarativeNetRequest = { getSessionRules: async () => [], updateSessionRules: async () => {} };
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    f.before(); f.headers({ responseHeaders: [{ name: 'Set-Cookie', value: 'source=dummy' }] });
    return new Response('fixture');
  };
  try {
    const broker = createSourceBroker(f.browser);
    const result = await new Promise(resolve => broker({ type: 'suwayomi:fetch', request: f.request }, { id: f.browser.runtime.id }, resolve));
    assert.equal(result.status, 200); assert.equal(atob(result.body), 'fixture');
    assert.ok(result.headers.some(([name, value]) => name === 'Set-Cookie' && value === 'source=dummy'));
    f.empty();
  } finally { globalThis.fetch = original; }
  delete f.browser.webRequest;
  await assert.rejects(createObservedFetch(f.browser, async () => assert.fail('must not fetch'))(f.request), /observation is unavailable/);
});

}
