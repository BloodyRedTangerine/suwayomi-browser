import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createSourceBroker, exactRequestPattern } from '../src/extensions/broker.mjs';
import { sourceFetchStreamHop } from '../src/extensions/transport.mjs';

for (const platform of ['chrome', 'firefox']) {
const test = (name, ...args) => nodeTest(`${platform}: ${name}`, ...args);
const getURL = function (path) { return (platform === 'firefox' ? 'moz-extension://fixture-uuid/' : `chrome-extension://${this.id}/`) + path; };

function createPortPair(name, senderId) {
  const makeEvent = () => {
    const listeners = new Set();
    return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: value => { for (const listener of listeners) listener(value); } };
  };
  const client = { name, onMessage: makeEvent(), onDisconnect: makeEvent() };
  const server = { name, sender: { id: senderId }, onMessage: makeEvent(), onDisconnect: makeEvent() };
  const sentToClient = [];
  let disconnected = false;
  client.postMessage = message => queueMicrotask(() => server.onMessage.emit(message));
  server.postMessage = message => { sentToClient.push(message); queueMicrotask(() => client.onMessage.emit(message)); };
  client.disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    queueMicrotask(() => { client.onDisconnect.emit(); server.onDisconnect.emit(); });
  };
  server.disconnect = client.disconnect;
  return { client, server, sentToClient };
}

function streamBrokerFixture(streamFetchRequest) {
  const browser = {
    runtime: { id: 'stream-extension', getURL, sendMessage: async () => {} },
    permissions: { contains: async () => true },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  };
  const broker = createSourceBroker(browser, undefined, streamFetchRequest);
  const { client, server, sentToClient } = createPortPair('suwayomi:fetch-stream', browser.runtime.id);
  broker.connect(server);
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { id: browser.runtime.id, connect: () => client } };
  return { browser, sentToClient, restore: () => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  } };
}

function fixture() {
  const changes = [], calls = [], permissionPrompts = [];
  let allow = true, rejectCleanup = false;
  const browser = {
    runtime: { id: 'test-extension', getURL, sendMessage: async message => permissionPrompts.push(message) },
    permissions: { contains: async () => allow },
    declarativeNetRequest: {
      getSessionRules: async () => [{ id: 1005 }],
      isRegexSupported: async () => ({ isSupported: true }),
      updateSessionRules: async change => {
        changes.push(change);
        if (rejectCleanup && !change.addRules?.length) throw new Error('cleanup unavailable');
      },
    },
  };
  const broker = createSourceBroker(browser, async request => { calls.push(request); return { status: 200 }; });
  return { browser, changes, calls, permissionPrompts, setAllow: value => { allow = value; }, failCleanup: value => { rejectCleanup = value; },
    request: (headers = []) => new Promise(resolve => broker({ type: 'suwayomi:fetch', request: { url: 'https://example.test/a*B?q=^x|y#fragment', headers } }, { id: browser.runtime.id }, resolve)), broker };
}

test('Empty controlled headers use Firefox removal while preserving Chromium literal empty values',async()=>{
  const value=fixture();
  const update=value.browser.declarativeNetRequest.updateSessionRules;
  value.browser.declarativeNetRequest.updateSessionRules=async change=>{
    for(const rule of change.addRules||[])for(const header of rule.action.requestHeaders)if(platform==='firefox'&&header.operation==='set'&&header.value==='')throw new Error('value is required for operations append/set');
    return update(change);
  };
  assert.equal((await value.request([['Referer',''],['Origin',''],['Cookie',''],['User-Agent','source-agent']])).status,200);
  const rule=value.changes.find(change=>change.addRules?.length).addRules[0];
  assert.deepEqual(rule.action.requestHeaders,[...['Referer','Origin','Cookie'].map(header=>platform==='firefox'?{header,operation:'remove'}:{header,operation:'set',value:''}),{header:'User-Agent',operation:'set',value:'source-agent'}]);
  assert.equal(rule.condition.regexFilter,exactRequestPattern('https://example.test/a*B?q=^x|y'));
  assert.deepEqual(value.calls[0].headers,[]);
  assert.deepEqual(value.changes.at(-1).removeRuleIds,[rule.id]);
});

test('Source header rules use exact case-sensitive URLs and are scoped to this extension', async () => {
  const value = fixture();
  await value.request([['Cookie', 'source-cookie=one'], ['Sec-CH-UA', '"Chromium";v="133"'], ['Sec-CH-UA-Mobile', '?0'], ['X-Test', 'kept']]);
  const rule = value.changes.find(change => change.addRules?.length).addRules[0];
  assert.deepEqual(value.changes[0].removeRuleIds, [1005]);
  const regex = new RegExp(rule.condition.regexFilter);
  assert.ok(regex.test('https://example.test/a*B?q=^x|y'));
  assert.ok(!regex.test('https://example.test/anythingB?q=xx|y'));
  assert.ok(!regex.test('https://example.test/a*b?q=^x|y'));
  assert.deepEqual(rule.condition.initiatorDomains, [platform === 'chrome' ? 'test-extension' : 'fixture-uuid']);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  assert.deepEqual(rule.action.requestHeaders.filter(header => header.header.toLowerCase().startsWith('sec-ch-ua')), [
    { header: 'Sec-CH-UA', operation: 'set', value: '"Chromium";v="133"' },
    { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
  ]);
  assert.deepEqual(value.calls[0].headers, [['X-Test', 'kept']]);
  assert.ok(value.changes.some(change => change.removeRuleIds.includes(rule.id)));
  assert.equal(exactRequestPattern('https://example.test/#x'), '^https://example\\.test/$');
});

test('Source broker rejects ungranted hosts and foreign senders without fetching', async () => {
  const value = fixture(); value.setAllow(false);
  assert.match((await value.request()).error, /Enable source access/);
  assert.equal(value.calls.length, 0);
  assert.deepEqual(value.permissionPrompts, [{ type: 'suwayomi:permission-required', origin: 'https://example.test/*' }]);
  assert.equal(value.broker({ type: 'suwayomi:fetch' }, { id: 'other' }, () => { throw new Error('unexpected'); }), undefined);
});

test('Failed rule cleanup blocks further fetches until cleanup succeeds', async () => {
  const value = fixture(); value.failCleanup(true);
  assert.match((await value.request()).error, /cleanup unavailable/);
  assert.equal(value.calls.length, 0);
  value.failCleanup(false);
  assert.equal((await value.request()).status, 200);
  assert.equal(value.calls.length, 1);
});

test('Source broker propagates a matching cancel message to the active Fetch signal', async () => {
  let begin;
  let signal;
  const started = new Promise(resolve => { begin = resolve; });
  const browser = {
    runtime: { id: 'cancel-extension', getURL, sendMessage: async () => {} },
    permissions: { contains: async () => true },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  };
  const broker = createSourceBroker(browser, async (_request, options) => new Promise((resolve, reject) => {
    signal = options.signal; begin();
    const abort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }));
  const send = message => new Promise(resolve => broker(message, { id: browser.runtime.id }, resolve));
  const request = send({ type: 'suwayomi:fetch', requestId: 'request-1', request: { url: 'https://source.example.test/slow', method: 'GET', headers: [] } });
  await started;
  assert.deepEqual(await send({ type: 'suwayomi:fetch-cancel', requestId: 'request-1' }), { ok: true });
  const response = await request;
  assert.equal(signal.aborted, true);
  assert.match(response.error, /aborted/i);
});

test('Stream broker exposes response headers and body chunks progressively through its port', async () => {
  let releaseSecond;
  let firstChunkSent;
  const firstSent = new Promise(resolve => { firstChunkSent = resolve; });
  const fixtureValue = streamBrokerFixture(async () => ({
    status: 206, statusText: 'Partial Content', url: 'https://source.example.test/chapter',
    headers: [['Content-Type', 'text/plain']],
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      firstChunkSent();
      releaseSecond = () => { controller.enqueue(new TextEncoder().encode('second')); controller.close(); };
    } }),
  }));
  try {
    const response = await sourceFetchStreamHop({ url: 'https://source.example.test/chapter', method: 'GET' });
    assert.equal(response.status, 206);
    assert.deepEqual(response.headers, [['Content-Type', 'text/plain']]);
    await firstSent;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixtureValue.sentToClient.map(message => message.type), ['headers', 'chunk'], 'the port allows only one unconsumed chunk in flight');
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
    let complete = false;
    const secondRead = reader.read().then(value => { complete = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(complete, false, 'the stream should remain open after its first chunk');
    releaseSecond();
    assert.equal(new TextDecoder().decode((await secondRead).value), 'second');
    assert.equal((await reader.read()).done, true);
  } finally { fixtureValue.restore(); }
});

test('Stream broker propagates caller cancellation to its active network request', async () => {
  let begin;
  let observedSignal;
  const started = new Promise(resolve => { begin = resolve; });
  const fixtureValue = streamBrokerFixture((_request, { signal }) => new Promise((resolve, reject) => {
    observedSignal = signal;
    begin();
    const abort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }));
  const controller = new AbortController();
  try {
    const pending = sourceFetchStreamHop({ url: 'https://source.example.test/slow', method: 'GET' }, { signal: controller.signal });
    await started;
    controller.abort(new DOMException('stream canceled by caller', 'AbortError'));
    await assert.rejects(pending, /stream canceled by caller/);
    assert.equal(observedSignal.aborted, true);
  } finally { fixtureValue.restore(); }
});

test('A paused streamed response does not block another source request in the broker queue', async () => {
  const browser = {
    runtime: { id: 'queue-stream-extension', getURL, sendMessage: async () => {} },
    permissions: { contains: async () => true },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  };
  const largeResponse = createPortPair('suwayomi:fetch-stream', browser.runtime.id);
  const quickResponse = createPortPair('suwayomi:fetch-stream', browser.runtime.id);
  let emittedLargeChunk;
  const largeChunk = new Promise(resolve => { emittedLargeChunk = resolve; });
  const broker = createSourceBroker(browser, undefined, async request => {
    if (new URL(request.url).pathname === '/large') return {
      status: 200, headers: [], body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); emittedLargeChunk(); } }),
    };
    return { status: 204, headers: [], body: null };
  });
  broker.connect(largeResponse.server);
  broker.connect(quickResponse.server);
  const originalChrome = globalThis.chrome;
  const ports = [largeResponse.client, quickResponse.client];
  globalThis.chrome = { runtime: { id: browser.runtime.id, connect: () => ports.shift() } };
  try {
    const slow = await sourceFetchStreamHop({ url: 'https://source.example.test/large', method: 'GET' });
    await largeChunk;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(largeResponse.sentToClient.map(message => message.type), ['headers', 'chunk']);
    let guardTimer;
    const quick = await Promise.race([
      sourceFetchStreamHop({ url: 'https://source.example.test/quick', method: 'GET' }),
      new Promise((_, reject) => { guardTimer = setTimeout(() => reject(new Error('queued behind a paused body stream')), 500); }),
    ]).finally(() => clearTimeout(guardTimer));
    assert.equal(quick.status, 204);
    assert.deepEqual(quickResponse.sentToClient.map(message => message.type), ['headers', 'end']);
    await slow.body.cancel('queue test finished');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

}
