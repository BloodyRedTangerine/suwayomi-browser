import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyApkV2Signature } from '../src/extensions/signature.mjs';
import { createSyntheticApk, createUnsignedApk, classesDexDataOffset } from './synthetic-apk.mjs';

globalThis.crypto ||= webcrypto;

function v2IdOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset--)
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { eocd = offset; break; }
  assert.notEqual(eocd, -1);
  const centralOffset = view.getUint32(eocd + 16, true);
  const blockSize = Number(view.getBigUint64(centralOffset - 24, true));
  const blockStart = centralOffset - blockSize - 8;
  let offset = blockStart + 8;
  const pairEnd = centralOffset - 24;
  while (offset < pairEnd) {
    const pairLength = Number(view.getBigUint64(offset, true));
    if (view.getUint32(offset + 8, true) === 0x7109871a) return offset + 8;
    offset += 8 + pairLength;
  }
  throw new Error('APK v2 block ID was not found');
}

test('synthetic APKs verify under every supported v2 algorithm and report the signing certificate fingerprint', async () => {
  for (const [algorithm, id] of [['rsa-pkcs1-sha256', 0x0103], ['rsa-pss-sha256', 0x0101], ['ecdsa-p256-sha256', 0x0201]]) {
    const { bytes, fingerprint } = createSyntheticApk({ algorithm });
    const result = await verifyApkV2Signature(bytes);
    assert.equal(result.scheme, 'apk-v2', algorithm);
    assert.deepEqual(result.fingerprints, [fingerprint], algorithm);
    assert.deepEqual(result.signatureAlgorithmIds, [id], algorithm);
  }
});

test('different signers have different fingerprints', async () => {
  const first = createSyntheticApk({ signer: 'alpha' });
  const second = createSyntheticApk({ signer: 'beta' });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual((await verifyApkV2Signature(second.bytes)).fingerprints, [second.fingerprint]);
});

test('APK v2 rejects a classes.dex modification after cryptographic signature validation', async () => {
  const { bytes } = createSyntheticApk();
  bytes[classesDexDataOffset(bytes) + 8] ^= 1;
  await assert.rejects(verifyApkV2Signature(bytes), /content digest does not match/);
});

test('APK v2 rejects an archive that carries no signing block', async () => {
  await assert.rejects(verifyApkV2Signature(createUnsignedApk()), /signing block magic is missing/);
});

test('APK v2 rejects truncated archives and a corrupted signing-block magic', async () => {
  const { bytes } = createSyntheticApk();
  await assert.rejects(verifyApkV2Signature(bytes.subarray(0, bytes.length - 100)), /End of Central Directory|truncated/);
  const corrupt = bytes.slice();
  const eocd = corrupt.length - 22 - new DataView(corrupt.buffer).getUint16(corrupt.length - 2, true);
  const centralOffset = new DataView(corrupt.buffer).getUint32(eocd + 16, true);
  corrupt[centralOffset - 1] ^= 1;
  await assert.rejects(verifyApkV2Signature(corrupt), /signing block magic/);
});

test('APK v2 refuses v3 and v3.1 blocks instead of silently falling back to v2', async () => {
  for (const [id, scheme] of [[0xf05368c0, 'v3'], [0x1b93ad61, 'v3.1']]) {
    const { bytes } = createSyntheticApk();
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(v2IdOffset(bytes), id, true);
    await assert.rejects(verifyApkV2Signature(bytes), new RegExp(`${scheme} signatures are present`));
  }
});

test('an additional v3 block next to a valid v2 block is refused too', async () => {
  const { bytes } = createSyntheticApk({ extraBlockId: 0xf05368c0 });
  await assert.rejects(verifyApkV2Signature(bytes), /v3 signatures are present/);
});

test('a certificate that does not match the signer public key is refused', async () => {
  const { bytes, identity } = createSyntheticApk({ signer: 'swap-a' });
  const other = createSyntheticApk({ signer: 'swap-b' }).identity;
  // Replace the embedded public key bytes: the signature then fails or the key/certificate comparison fails.
  const index = Buffer.from(bytes).indexOf(identity.publicKeyDer);
  assert.ok(index > 0);
  const copy = bytes.slice();
  copy.set(other.publicKeyDer.subarray(0, identity.publicKeyDer.length), index);
  await assert.rejects(verifyApkV2Signature(copy));
});
