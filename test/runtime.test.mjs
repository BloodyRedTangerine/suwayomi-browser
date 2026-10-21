import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionRuntime } from '../src/extensions/runtime.mjs';
import { browserFetch, browserFetchStream, sourceFetchHop, encodeBytes, decodeBytes } from '../src/extensions/transport.mjs';

test('Browser transport preserves binary bodies without borrowing browser login sessions', async () => {
  const original = globalThis.fetch;
  let options;
  globalThis.fetch = async (_url, init) => { options = init; return new Response(new Uint8Array([0, 128, 255]), { headers: { 'Content-Type': 'image/png' } }); };
  try {
    const result = await browserFetch({ url: 'https://source.example.test', method: 'POST', body: encodeBytes(new Uint8Array([1, 0, 255])) });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual([...options.body], [1, 0, 255]);
    assert.deepEqual([...decodeBytes(result.body)], [0, 128, 255]);
    await assert.rejects(browserFetch({ url: 'file:///private' }), /HTTP/);
  } finally { globalThis.fetch = original; }
});

test('Fetch preserves body content types and bytes but lets the browser own wire framing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('content-type'), 'application/octet-stream');
    assert.equal(options.headers.get('content-length'), null);
    assert.equal(options.headers.get('transfer-encoding'), null);
    assert.deepEqual([...options.body], [0, 128, 255]);
    return new Response('ok');
  };
  try {
    await browserFetch({ url: 'https://source.example.test', method: 'POST', headers: [['Content-Type', 'application/octet-stream'], ['Content-Length', '999'], ['Transfer-Encoding', 'chunked']], body: encodeBytes(new Uint8Array([0, 128, 255])) });
  } finally { globalThis.fetch = original; }
});

test('Browser Fetch exposes response headers before the body finishes and streams original chunks', async () => {
  const originalFetch = globalThis.fetch;
  let options, upstream;
  globalThis.fetch = async (_url, init) => {
    options = init;
    return new Response(new ReadableStream({ start(controller) {
      upstream = controller;
      controller.enqueue(new Uint8Array([1]));
    } }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': '99' } });
  };
  try {
    const response = await browserFetchStream({ url: 'https://source.example.test/stream', method: 'GET' });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(response.headers.find(([name]) => name.toLowerCase() === 'content-encoding'), undefined);
    assert.equal(response.headers.find(([name]) => name.toLowerCase() === 'content-length'), undefined);
    const reader = response.body.getReader();
    assert.deepEqual([...(await reader.read()).value], [1]);
    upstream.enqueue(new Uint8Array([2, 3]));
    upstream.close();
    assert.deepEqual([...(await reader.read()).value], [2, 3]);
    assert.equal((await reader.read()).done, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Cancelling a streamed browser response cancels its underlying Fetch', async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal;
  globalThis.fetch = async (_url, init) => {
    observedSignal = init.signal;
    return new Response(new ReadableStream({ start() {} }));
  };
  try {
    const response = await browserFetchStream({ url: 'https://source.example.test/slow', method: 'GET' });
    await response.body.cancel('fixture cancellation');
    assert.equal(observedSignal.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Browser Fetch cancels an active network request when its caller aborts', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let observedSignal;
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    observedSignal = options.signal;
    const abort = () => reject(observedSignal.reason || new DOMException('aborted', 'AbortError'));
    if (observedSignal.aborted) abort(); else observedSignal.addEventListener('abort', abort, { once: true });
  });
  try {
    const pending = browserFetch({ url: 'https://source.example.test/slow', method: 'GET' }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new DOMException('cancel fixture', 'AbortError'));
    await assert.rejects(pending, /cancel fixture/);
    assert.equal(observedSignal.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Extension source transport relays caller aborts to its background broker', async () => {
  const originalChrome = globalThis.chrome;
  const controller = new AbortController();
  const messages = [];
  let resolveFetch;
  globalThis.chrome = { runtime: { id: 'test-extension', sendMessage: message => {
    messages.push(message);
    if (message.type === 'suwayomi:fetch') return new Promise(resolve => { resolveFetch = resolve; });
    if (message.type === 'suwayomi:fetch-cancel') { resolveFetch({ error: 'cancelled' }); return Promise.resolve({ ok: true }); }
    return Promise.resolve(undefined);
  } } };
  try {
    const pending = sourceFetchHop({ url: 'https://source.example.test/slow', method: 'GET' }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new DOMException('cancel fixture', 'AbortError'));
    await assert.rejects(pending, /cancel fixture/);
    assert.equal(messages[0].type, 'suwayomi:fetch');
    assert.equal(messages[1].type, 'suwayomi:fetch-cancel');
    assert.equal(messages[0].requestId, messages[1].requestId);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('Closed extension workers reject new requests and pending timers are cleared', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() { this.terminated = true; } };
  try {
    const runtime = new ExtensionRuntime();
    assert.equal(runtime.transport, sourceFetchHop, 'The JVM must receive each individual HTTP response');
    const pending = runtime.smoke();
    runtime.dispose();
    await assert.rejects(pending, /closed/i);
    await assert.rejects(runtime.smoke(), /closed/i);
    assert.equal(runtime.pending.size, 0);
    assert.equal(runtime.worker.terminated, true);
  } finally { globalThis.Worker = original; }
});

test('Fetch-decoded response headers cannot trigger a second JVM decompression', async () => {
  const original = globalThis.fetch;
  try {
    for (const encoding of ['gzip', 'br', 'zstd', 'gzip, br']) {
      globalThis.fetch = async () => new Response('already decoded', { headers: { 'Content-Encoding': encoding, 'Content-Length': '7', 'Content-Type': 'application/json' } });
      const result = await browserFetch({ url: 'https://source.example.test', method: 'GET' });
      const headers = new Headers(result.headers);
      assert.equal(headers.has('content-encoding'), false);
      assert.equal(headers.has('content-length'), false);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(new TextDecoder().decode(decodeBytes(result.body)), 'already decoded');
    }
  } finally { globalThis.fetch = original; }
});
