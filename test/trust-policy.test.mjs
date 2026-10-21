import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSignerTrust, normalizeSignerFingerprint } from '../src/extensions/trust-policy.mjs';
import { parseJarV1Verification } from '../src/extensions/signature.mjs';

const trusted = '9add655a78e96c4ec7a53ef89dccb557cb5d767489fac5e785d671a5a75d4da2';
const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('signer fingerprint normalization accepts hex case/colons and rejects malformed values', () => {
  assert.equal(normalizeSignerFingerprint(trusted.toUpperCase().replace(/(..)(?=.)/g, '$1:')), trusted);
  assert.throws(() => normalizeSignerFingerprint('not-a-fingerprint'), /Invalid signer fingerprint/);
});

test('repository signer and previously trusted signer are both enforced', () => {
  const signature = { scheme: 'jar-v1', fingerprints: [trusted] };
  assert.equal(assertSignerTrust(signature, { packageName: 'fixture', repositoryFingerprint: trusted, existingFingerprint: trusted }), trusted);
  assert.throws(() => assertSignerTrust(signature, { packageName: 'fixture', repositoryFingerprint: other }), /does not match repository signing key/);
  assert.throws(() => assertSignerTrust(signature, { packageName: 'fixture', existingFingerprint: other }), /changed from .*uninstall first/);
});

test('empty or multi-certificate identity sets are refused', () => {
  assert.throws(() => assertSignerTrust({ fingerprints: [] }), /exactly one distinct signing certificate/);
  assert.throws(() => assertSignerTrust({ fingerprints: [trusted, other] }), /exactly one distinct signing certificate/);
});

test('JAR runtime response is accepted only in the strict jar-v1 fingerprint format', () => {
  assert.deepEqual(parseJarV1Verification(`jar-v1:${trusted}`), { scheme: 'jar-v1', fingerprints: [trusted] });
  assert.throws(() => parseJarV1Verification('jar-v1:unknown'), /invalid signer fingerprint/);
});
