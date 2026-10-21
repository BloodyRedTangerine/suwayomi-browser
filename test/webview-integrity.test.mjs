import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { corsResponseAllowed, parseSubresourceIntegrity, verifySubresourceIntegrity } from '../src/extensions/webview-integrity.mjs';

const bytes = new TextEncoder().encode('stylesheet fixture');
const digest = algorithm => createHash(algorithm).update(bytes).digest('base64');

test('SRI verifies supported hashes and selects only the strongest algorithm', async () => {
  const valid256 = digest('sha256');
  const valid384 = digest('sha384');
  const valid512 = digest('sha512');
  assert.equal(await verifySubresourceIntegrity(bytes, `sha256-${valid256} sha384-${valid384}`), true);
  assert.equal(await verifySubresourceIntegrity(bytes, `sha384-invalid sha384-${valid384}?future-option`), true);
  assert.equal(await verifySubresourceIntegrity(bytes, `sha384-${valid384} sha512-invalid`), false);
  assert.equal(await verifySubresourceIntegrity(bytes, `sha512-${valid512}`), true);
});

test('SRI parser ignores unsupported algorithms and options, but rejects malformed known digests', async () => {
  const valid256 = digest('sha256');
  assert.deepEqual(parseSubresourceIntegrity(`  sha1-old sha256-${valid256}?opt?later\nsha512-`), [
    { algorithm: 'sha256', digest: valid256 },
    { algorithm: 'sha512', digest: '' },
  ]);
  assert.equal(await verifySubresourceIntegrity(bytes, `sha1-unsupported sha256-${valid256}`), true);
  assert.equal(await verifySubresourceIntegrity(bytes, 'sha1-unsupported'), true);
  assert.equal(await verifySubresourceIntegrity(bytes, 'sha512-'), false);
  await assert.rejects(verifySubresourceIntegrity(bytes, 'sha512-valid', {}), /Web Crypto SHA-2 support/);
});

test('SRI checks bytes before any stylesheet text processing', async () => {
  const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('.x{color:red}')]);
  const expected = createHash('sha384').update(original).digest('base64');
  assert.equal(await verifySubresourceIntegrity(original, `sha384-${expected}`), true);
  assert.equal(await verifySubresourceIntegrity(new TextEncoder().encode('.x{color:red}'), `sha384-${expected}`), false);
});

test('cross-origin SRI CORS accepts anonymous wildcard and credentialed exact-origin responses only', () => {
  const origin = 'https://webview.example.test';
  const resourceUrl = 'https://cdn.example.test/style.css';
  const anonymous = { headers: [['Access-Control-Allow-Origin', '*']] };
  assert.equal(corsResponseAllowed(anonymous, { documentOrigin: origin, resourceUrl, credentialsMode: 'same-origin' }), true);
  assert.equal(corsResponseAllowed(anonymous, { documentOrigin: origin, resourceUrl, credentialsMode: 'include' }), false);
  assert.equal(corsResponseAllowed({ headers: [
    ['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Credentials', 'true'],
  ] }, { documentOrigin: origin, resourceUrl, credentialsMode: 'include' }), true);
  assert.equal(corsResponseAllowed({ headers: [
    ['Access-Control-Allow-Origin', '*'], ['Access-Control-Allow-Credentials', 'true'],
  ] }, { documentOrigin: origin, resourceUrl, credentialsMode: 'include' }), false);
  assert.equal(corsResponseAllowed({ headers: [['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Origin', origin]] }, {
    documentOrigin: origin, resourceUrl, credentialsMode: 'same-origin',
  }), false);
  assert.equal(corsResponseAllowed({ headers: [] }, { documentOrigin: origin, resourceUrl: `${origin}/same.css` }), true);
});
