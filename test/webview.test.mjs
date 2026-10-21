import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWebViewHost, composeSrcdoc, injectResponseSecurityPolicies } from '../src/extensions/webview.mjs';

test('sandboxed WebView bootstrap script parses and preserves its base URL', () => {
  const payload = [
    { url: 'https://webview.example.test/solver.js', code: 'window.fixture = "</script>";', defer: true },
    { url: 'https://webview.example.test/async.js', code: 'window.asyncFixture = true;', async: true },
  ];
  const html = composeSrcdoc('test-key', 'https://webview.example.test/@waf/solver', '<head><title>fixture</title></head><script>window.__suwayomiRunExternalScript(0)</script>', payload, ['https://webview.example.test/images/fixture.svg']);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  assert.match(html, /<base href="https:\/\/webview\.example\.test\/@waf\/solver">/);
  assert.match(scripts[0], /window\.fetch=/);
  assert.match(scripts[0], /window\.XMLHttpRequest=/);
  assert.match(scripts[0], /new TextDecoder\(charset\)\.decode\(bytes\)/);
  assert.match(scripts[0], /this\.__fireProgress\(loaded,response\.headers\.get\('content-length'\)\)/);
  assert.match(scripts[0], /state\.timer=setTimeout\(\(\)=>fail\('timeout'\)/);
  assert.match(scripts[0], /state\.aborted=true;state\.terminal=true/);
  assert.match(scripts[0], /type:'resourceAbort'/);
  assert.match(scripts[0], /req\.signal/);
  assert.match(scripts[0], /state\.controller\.abort/);
  assert.match(scripts[0], /deferredScriptIndexes=externalScripts\.map/);
  assert.match(scripts[0], /document\.readyState!=='interactive'/);
  assert.match(scripts[0], /window\.\_\_suwayomiRunExternalScript=function/);
  assert.match(scripts[0], /window\.\_\_suwayomiRunExternalScriptAsync=function/);
  assert.match(scripts[0], /setTimeout\(function\(\)\{try\{window\.\_\_suwayomiRunExternalScript\(index\)/);
  assert.match(scripts[0], /window\.\_\_suwayomiAsyncScriptPromises\.push\(completion\)/);
  assert.match(scripts[0], /window\.\_\_suwayomiLoadExternalImage=function/);
  assert.match(scripts[0], /function corsAllowed\(response,mode\)/);
  assert.match(scripts[0], /cspDirective/);
  assert.match(scripts[0], /brokerFetch\(url\.href,\{method:'GET'\},'img-src'\)/);
  assert.match(scripts[0], /script\.setAttribute\('nonce',item\.nonce\)/);
  assert.match(scripts[0], /const key="test-key", documentOrigin="https:\/\/webview\.example\.test"/);
  assert.match(scripts[0], /taintedCanvases=new WeakSet\(\)/);
  assert.match(scripts[0], /canvasSecurityError\(\)/);
  assert.match(scripts[0], /getImageData=function/);
  assert.match(scripts[0], /convertToBlob=function/);
  assert.match(scripts[0], /document\.addEventListener\('error',blockedSourceSet,true\)/);
  assert.match(scripts[0], /HTMLSourceElement\.prototype/);
  assert.match(scripts[0], /function evaluationNonce\(\)/);
  assert.match(scripts[0], /function appendInlineEvaluation\(/);
  assert.match(scripts[0], /new Blob\(\[source\],\{type:'text\/javascript'\}\)/);
  assert.doesNotMatch(scripts[0], /\(0,eval\)/, 'WebView JavaScript evaluation must not require unsafe-eval');
  assert.match(scripts[0], /externalImages=\["https:\/\/webview\.example\.test\/images\/fixture\.svg"\]/);
  assert.match(html, /img-src blob: data:/);
  assert.match(html, /connect-src 'none'/);
  assert.match(scripts[0], /\\u003c\/script\\u003e/);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test('remote loadUrl asks the JVM main-frame callback before native navigation and releases its rule after load', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const calls = [];
  const listeners = new Map();
  const frame = {
    dataset: {}, style: {},
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    remove() { this.removed = true; },
  };
  globalThis.document = { createElement: () => frame, documentElement: { append() {} } };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const host = new BrowserWebViewHost({ navigationBridge: async message => {
      calls.push(message);
      return message.action === 'begin' ? { ok: true, ruleId: 2_000_000_001 } : { ok: true };
    } });
    await host.handle({ action: 'create', session: 'remote-loadurl' });
    const loading = host.handle({
      action: 'loadUrl', session: 'remote-loadurl',
      url: 'https://reader.example.test/challenge', headers: { Referer: 'https://reader.example.test/' },
    });
    const session = host.sessions.get('remote-loadurl');
    const mainFrame = await session.nextEvent();
    assert.equal(mainFrame.type, 'mainFrameRequest');
    assert.equal(mainFrame.url, 'https://reader.example.test/challenge');
    assert.equal(mainFrame.method, 'GET');
    assert.deepEqual(mainFrame.headers, [['Referer', 'https://reader.example.test/']]);
    await host.handle({ action: 'mainFrameInterceptResult', session: 'remote-loadurl', resourceId: mainFrame.id, response: null });
    const response = await loading;
    assert.equal(frame.src, 'https://reader.example.test/challenge');
    assert.deepEqual(calls[0], {
      action: 'begin', url: 'https://reader.example.test/challenge', headers: { Referer: 'https://reader.example.test/' },
    });
    assert.match(response.limitation, /exact initial frame navigation/);

    listeners.get('load')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls[1], { action: 'end', ruleId: 2_000_000_001 });
    await host.handle({ action: 'close', session: 'remote-loadurl' });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('intercepted main-frame response CSP headers are inserted before source HTML', () => {
  const html = injectResponseSecurityPolicies('<!doctype html><html><head><title>fixture</title></head><body></body></html>', [
    ['Content-Security-Policy', "default-src 'none'; script-src 'self'"],
    ['content-security-policy', "img-src 'none'; report-uri https://reports.example.test/csp"],
    ['X-Content-Type-Options', 'nosniff'],
  ]);
  assert.ok(html.includes(`<head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;">`));
  assert.ok(html.includes(`content="img-src &#39;none&#39;; report-uri https://reports.example.test/csp"><title>`));
  assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) || []).length, 2);
});

test('unhandled WebView resource bodies stay in browser transport while Java receives cookie headers', async () => {
  const body = 'large-script-body';
  const headers = [['Content-Type', 'application/javascript'], ['Set-Cookie', 'source_cookie=retained; Path=/; Secure; HttpOnly']];
  const host = new BrowserWebViewHost({ transport: async () => ({ status: 200, statusText: 'OK', headers, body }) });
  await host.handle({ action: 'create', session: 'large-resource' });
  const session = host.sessions.get('large-resource');
  const bodyReady = new Promise((resolve, reject) => session.resourceWaiters.set('resource-1', { resolve, reject }));
  const result = await host.handle({
    action: 'resourceResult',
    session: 'large-resource',
    resourceId: 'resource-1',
    request: { url: 'https://docs.example.test/opencv.js', method: 'GET', headers: [], body: '' },
    response: null,
  });
  assert.equal(result.deferred, true);
  assert.deepEqual(result.responseMeta, { headers });
  assert.equal('body' in result, false);
  assert.equal((await bodyReady).body, body);
  host.sessions.clear();
});

test('WebView streams response headers and chunks to the sandbox as they arrive', async () => {
  const messages = [];
  let firstChunkSeen, secondChunkSeen;
  const firstChunk = new Promise(resolve => { firstChunkSeen = resolve; });
  const secondChunk = new Promise(resolve => { secondChunkSeen = resolve; });
  let streamEnded;
  const ended = new Promise(resolve => { streamEnded = resolve; });
  const host = new BrowserWebViewHost({ streamTransport: async () => ({
    status: 200, statusText: 'OK', url: 'https://source.example.test/stream',
    headers: [['Content-Type', 'text/plain']],
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('second'));
      controller.close();
    } }),
  }) });
  await host.handle({ action: 'create', session: 'stream-resource' });
  const session = host.sessions.get('stream-resource');
  let chunkCount = 0;
  session.iframe = { contentWindow: { postMessage(message) {
    messages.push(message);
    if (message.type === 'resourceChunk' && ++chunkCount === 1) firstChunkSeen();
    if (message.type === 'resourceChunk' && chunkCount === 2) secondChunkSeen();
    if (message.type === 'resourceEnd') streamEnded();
  } } };
  const result = await host.handle({
    action: 'resourceResult', session: 'stream-resource', resourceId: 'stream-1',
    request: { url: 'https://source.example.test/stream', method: 'GET', headers: [], body: '' }, response: null,
  });
  assert.equal(result.deferred, true);
  assert.deepEqual(result.responseMeta, { headers: [['Content-Type', 'text/plain']] });
  await firstChunk;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages.map(message => message.type), ['resourceHeaders', 'resourceChunk'], 'the sandbox must acknowledge a chunk before the next is posted');
  const acknowledge = () => session.onMessage({ source: session.iframe.contentWindow, data: { key: session.key, type: 'resourceAck', id: 'stream-1' } });
  acknowledge();
  await secondChunk;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages.map(message => message.type), ['resourceHeaders', 'resourceChunk', 'resourceChunk']);
  acknowledge();
  await ended;
  assert.deepEqual(messages.map(message => message.type), ['resourceHeaders', 'resourceChunk', 'resourceChunk', 'resourceEnd']);
  assert.deepEqual(messages.slice(1, 3).map(message => new TextDecoder().decode(Uint8Array.from(atob(message.body), char => char.charCodeAt(0)))), ['first', 'second']);
  assert.equal(session.resourceControllers.size, 0);
  host.sessions.clear();
});

test('pre-document WebView resources buffer bounded fetch streams for decoding and SRI', async () => {
  const source = new TextEncoder().encode('stylesheet bytes');
  const host = new BrowserWebViewHost({ streamTransport: async request => ({
    status: 200, statusText: 'OK', url: request.url, headers: [['Content-Type', 'text/css']],
    body: new ReadableStream({ start(controller) {
      controller.enqueue(source.slice(0, 5));
      controller.enqueue(source.slice(5));
      controller.close();
    } }),
  }) });
  await host.handle({ action: 'create', session: 'pre-document-stream' });
  const session = host.sessions.get('pre-document-stream');
  const pending = session.requestPageResource('https://source.example.test/style.css', 'https://source.example.test/page');
  const event = await session.nextEvent();
  const result = await host.handle({
    action: 'resourceResult', session: 'pre-document-stream', resourceId: event.id,
    request: { url: event.url, method: 'GET', headers: event.headers, body: '' }, response: null,
  });
  assert.equal(result.deferred, true);
  const response = await pending;
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(response.body), character => character.charCodeAt(0))), 'stylesheet bytes');
  assert.equal(response.url, event.url);
  assert.equal(session.resourceControllers.size, 0);
  host.sessions.clear();
});

test('WebView abort signal cancels its active browser transport request', async () => {
  let begin;
  let observedSignal;
  const started = new Promise(resolve => { begin = resolve; });
  const host = new BrowserWebViewHost({ transport: async (_request, { signal }) => new Promise((resolve, reject) => {
    observedSignal = signal;
    begin();
    const abort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }) });
  await host.handle({ action: 'create', session: 'cancel-xhr' });
  const session = host.sessions.get('cancel-xhr');
  session.iframe = { contentWindow: { postMessage() {} } };
  const pending = host.handle({
    action: 'resourceResult', session: 'cancel-xhr', resourceId: 'xhr-1',
    request: { url: 'https://source.example.test/slow', method: 'GET', headers: [], body: '' }, response: null,
  });
  await started;
  session.abortResource('xhr-1');
  const response = await pending;
  assert.equal(observedSignal.aborted, true);
  assert.match(response.error, /aborted/i);
  assert.equal(session.resourceControllers.size, 0);
  host.sessions.clear();
});

test('SRI stylesheet CORS mode and credentials are preserved and checked on every redirect hop', async () => {
  const host = new BrowserWebViewHost();
  await host.handle({ action: 'create', session: 'sri-redirects' });
  const session = host.sessions.get('sri-redirects');
  const pending = session.requestPageResource('https://cdn.example.test/first.css', 'https://webview.example.test/page', {
    corsMode: true, requireCors: true, credentialsMode: 'same-origin', requestOrigin: 'https://webview.example.test',
  });
  const first = await session.nextEvent();
  assert.equal(first.type, 'resourceRequest');
  assert.equal(first.corsMode, true);
  assert.equal(first.credentialsMode, 'same-origin');
  assert.equal(first.requestOrigin, 'https://webview.example.test');
  assert.ok(first.headers.some(([name, value]) => name.toLowerCase() === 'origin' && value === 'https://webview.example.test'));
  session.completeResource({ resourceId: first.id, response: {
    status: 302, headers: [['Location', 'https://assets.example.test/final.css'], ['Access-Control-Allow-Origin', '*']], body: '',
  } });
  const second = await session.nextEvent();
  assert.ok(second.headers.some(([name, value]) => name.toLowerCase() === 'origin' && value === 'https://webview.example.test'));
  session.completeResource({ resourceId: second.id, response: {
    status: 200, headers: [['Access-Control-Allow-Origin', '*']], body: 'YQ==',
  } });
  const final = await pending;
  assert.equal(final.url, 'https://assets.example.test/final.css');
  assert.equal(final.body, 'YQ==');
  host.sessions.clear();
});

test('SRI stylesheet redirects fail closed when any cross-origin hop omits CORS headers', async () => {
  const host = new BrowserWebViewHost();
  await host.handle({ action: 'create', session: 'sri-cors-failure' });
  const session = host.sessions.get('sri-cors-failure');
  const pending = session.requestPageResource('https://cdn.example.test/first.css', 'https://webview.example.test/page', {
    corsMode: true, requireCors: true, credentialsMode: 'same-origin', requestOrigin: 'https://webview.example.test',
  });
  const event = await session.nextEvent();
  session.completeResource({ resourceId: event.id, response: {
    status: 302, headers: [['Location', 'https://assets.example.test/final.css']], body: '',
  } });
  await assert.rejects(pending, /failed its CORS check/);
  assert.equal(session.events.length, 0, 'a denied redirect target must not be requested');
  host.sessions.clear();
});

test('cross-origin SRI without a CORS settings attribute is rejected before requesting bytes', async () => {
  const host = new BrowserWebViewHost();
  await host.handle({ action: 'create', session: 'sri-no-cors' });
  const session = host.sessions.get('sri-no-cors');
  await assert.rejects(session.requestPageResource('https://cdn.example.test/style.css', 'https://webview.example.test/page', {
    requireCors: true, corsMode: false, credentialsMode: 'same-origin', requestOrigin: 'https://webview.example.test',
  }), /requires CORS/);
  assert.equal(session.events.length, 0);
  host.sessions.clear();
});
