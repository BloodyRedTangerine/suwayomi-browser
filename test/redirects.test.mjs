import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRedirects, browserFetch, sourceFetchHop } from '../src/extensions/transport.mjs';

test('Stateless repository/image requests follow each hop without browser automatic redirects', async () => {
  const seen = [];
  const response = await fetchWithRedirects({ url: 'https://repo.test/start', headers: [['Authorization', 'dummy'], ['Cookie', 'dummy'], ['X-Keep', 'yes']] }, async request => {
    seen.push(request);
    return seen.length === 1 ? { status: 302, headers: [['Location', '/relative']] } : seen.length === 2 ? { status: 307, headers: [['Location', 'https://download.test/file']] } : { status: 200, body: 'AA==' };
  });
  assert.equal(response.status, 200);
  assert.equal(seen[1].url, 'https://repo.test/relative');
  assert.deepEqual(seen[1].headers, seen[0].headers);
  assert.deepEqual(seen[2].headers, [['X-Keep', 'yes']]);
});

test('Stateless follow-ups bound loops, preserve 307/308 bodies, and drop rewritten method body headers', async () => {
  let count = 0;
  await assert.rejects(fetchWithRedirects({ url: 'https://repo.test/' }, async () => { count++; return { status: 302, headers: [['Location', '/loop']] }; }), /Too many/);
  assert.equal(count, 21);
  for (const code of [301, 302, 303, 307, 308]) {
    const seen = [];
    await fetchWithRedirects({ url: 'https://repo.test/', method: 'POST', body: 'dummy', headers: [['Content-Type', 'text/plain']] }, async request => { seen.push(request); return seen.length === 1 ? { status: code, headers: [['Location', '/next']] } : { status: 200 }; });
    assert.equal(seen[1].method, code >= 307 ? 'POST' : 'GET');
    assert.equal(seen[1].body, code >= 307 ? 'dummy' : undefined);
    assert.equal(seen[1].headers.length, code >= 307 ? 1 : 0);
  }
  for (const location of [undefined, 'file:///private', 'http://[invalid']) {
    let count = 0;
    const response = await fetchWithRedirects({ url: 'https://repo.test/' }, async () => { count++; return { status: 302, headers: location ? [['Location', location]] : [] }; });
    assert.equal(count, 1); assert.equal(response.status, 302);
  }
  await assert.rejects(fetchWithRedirects({ url: 'https://repo.test/' }, async () => ({ status: 302, headers: [['Location', 'https://dummy:dummy@other.test/']] })), /Embedded URL credentials/);
});

test('Ordinary webpage manual redirects fail explicitly; JVM transport does not silently auto-follow', async () => {
  const original = globalThis.fetch;
  let options;
  globalThis.fetch = async (_url, init) => { options = init; return { type: 'opaqueredirect' }; };
  try {
    assert.equal((await browserFetch({ url: 'https://repo.test/' })).status, 0);
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    await assert.rejects(sourceFetchHop({ url: 'https://repo.test/' }), /requires the installed browser extension/);
    await assert.rejects(browserFetch({ url: 'https://dummy:dummy@repo.test/' }), /Embedded URL credentials/);
  } finally { globalThis.fetch = original; }
});
