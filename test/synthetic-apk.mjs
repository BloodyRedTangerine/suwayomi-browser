// Builds a synthetic, validly signed APK (Signature Scheme v2) and a synthetic JAR for tests.
// Nothing here comes from a real extension: the archive holds placeholder entries and is signed with a throw-away key
// generated on the fly, so tests can verify, tamper with and refuse signed packages without any third-party binary.
import { createHash, generateKeyPairSync, sign, constants } from 'node:crypto';
import { createZip } from '../scripts/deterministic-zip.mjs';

const ALGORITHMS = {
  'rsa-pkcs1-sha256': { id: 0x0103, hash: 'sha256', key: 'rsa', certificateOid: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b] },
  'rsa-pss-sha256': { id: 0x0101, hash: 'sha256', key: 'rsa', pss: true, certificateOid: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b] },
  'ecdsa-p256-sha256': { id: 0x0201, hash: 'sha256', key: 'ec', certificateOid: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02] },
};
const keyCache = new Map();

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const oid = bytes => der(0x06, Buffer.from(bytes));
const name = common => der(0x30, der(0x31, der(0x30, oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from(common)))));

/** Self-signed X.509 certificate (DER) for the synthetic signer. */
function certificate(publicKey, privateKey, algorithm, common) {
  const algorithmIdentifier = der(0x30, oid(algorithm.certificateOid), ...(algorithm.key === 'rsa' ? [der(0x05)] : []));
  const validity = der(0x30, der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('450101000000Z')));
  const tbs = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithmIdentifier, name(common), validity, name(common), Buffer.from(publicKey.export({ type: 'spki', format: 'der' })));
  const signature = sign('sha256', tbs, privateKey);
  return der(0x30, tbs, algorithmIdentifier, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/** A deterministic-within-a-process signing identity per algorithm (fresh key pair per test process). */
export function signingIdentity(algorithmName = 'rsa-pkcs1-sha256', label = 'default') {
  const algorithm = ALGORITHMS[algorithmName];
  if (!algorithm) throw new Error('Unknown synthetic signing algorithm: ' + algorithmName);
  const cacheKey = algorithmName + ':' + label;
  if (!keyCache.has(cacheKey)) {
    const { publicKey, privateKey } = algorithm.key === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const certificateDer = certificate(publicKey, privateKey, algorithm, 'Synthetic test signer ' + label);
    keyCache.set(cacheKey, {
      algorithm, algorithmName, privateKey,
      publicKeyDer: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })), certificate: certificateDer,
      fingerprint: createHash('sha256').update(certificateDer).digest('hex'),
    });
  }
  return keyCache.get(cacheKey);
}

const u32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
const u64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
const prefixed = buffer => Buffer.concat([u32(buffer.length), buffer]);
const sequence = items => Buffer.concat(items.map(prefixed));

function chunkedDigest(sections, hash) {
  const digests = [];
  for (const section of sections) {
    for (let offset = 0; offset < section.length; offset += 1 << 20) {
      const chunk = section.subarray(offset, Math.min(offset + (1 << 20), section.length));
      digests.push(createHash(hash).update(Buffer.concat([Buffer.from([0xa5]), u32(chunk.length), chunk])).digest());
    }
  }
  return createHash(hash).update(Buffer.concat([Buffer.from([0x5a]), u32(digests.length), ...digests])).digest();
}

/** Placeholder archive entries: a manifest stand-in, a "dex" payload and a resource table. */
export function placeholderEntries(seed = 'synthetic') {
  return [
    { name: 'AndroidManifest.xml', data: Buffer.from('binary-manifest-placeholder:' + seed) },
    { name: 'classes.dex', data: Buffer.concat([Buffer.from('dex\n035\0'), Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 31 + seed.length) & 0xff))]) },
    { name: 'resources.arsc', data: Buffer.from('resource-table-placeholder') },
  ];
}

/**
 * @param {object} [options]
 * @param {string} [options.algorithm] rsa-pkcs1-sha256 | rsa-pss-sha256 | ecdsa-p256-sha256
 * @param {string} [options.signer]    label of the signing identity (different labels give different certificates)
 * @param {Array}  [options.entries]   archive entries ({name, data})
 * @param {number} [options.extraBlockId] add an unrelated signing-block pair (for example 0xf05368c0 to model v3)
 * @returns {{ bytes: Uint8Array, fingerprint: string, identity: object }}
 */
export function createSyntheticApk({ algorithm = 'rsa-pkcs1-sha256', signer = 'default', entries = placeholderEntries(), extraBlockId } = {}) {
  const identity = signingIdentity(algorithm, signer);
  const zip = createZip(entries, { epochSeconds: 1792540800, level: 6 });
  let eocd = zip.length - 22;
  while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const centralOffset = zip.readUInt32LE(eocd + 16);
  const beforeCentral = zip.subarray(0, centralOffset);
  const central = zip.subarray(centralOffset, eocd);
  const end = Buffer.from(zip.subarray(eocd));
  const digest = chunkedDigest([beforeCentral, central, end], identity.algorithm.hash);
  const digests = sequence([Buffer.concat([u32(identity.algorithm.id), prefixed(digest)])]);
  const signedData = Buffer.concat([prefixed(digests), prefixed(sequence([identity.certificate])), prefixed(Buffer.alloc(0))]);
  const options = identity.algorithm.pss
    ? { key: identity.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
    : identity.privateKey;
  const signatureBytes = sign(identity.algorithm.hash, signedData, options);
  const signatures = sequence([Buffer.concat([u32(identity.algorithm.id), prefixed(signatureBytes)])]);
  const signerRecord = Buffer.concat([prefixed(signedData), prefixed(signatures), prefixed(identity.publicKeyDer)]);
  const v2Value = prefixed(sequence([signerRecord]));
  const pairs = [Buffer.concat([u64(4 + v2Value.length), u32(0x7109871a), v2Value])];
  if (extraBlockId) pairs.push(Buffer.concat([u64(4), u32(extraBlockId)]));
  const pairsBytes = Buffer.concat(pairs);
  const blockSize = pairsBytes.length + 8 + 16;
  const block = Buffer.concat([u64(blockSize), pairsBytes, u64(blockSize), Buffer.from('APK Sig Block 42')]);
  end.writeUInt32LE(centralOffset + block.length, 16);
  const bytes = Buffer.concat([beforeCentral, block, central, end]);
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), fingerprint: identity.fingerprint, identity };
}

/** An APK-shaped archive without any signing block (must be refused). */
export function createUnsignedApk(entries = placeholderEntries('unsigned')) {
  const zip = createZip(entries, { epochSeconds: 1792540800, level: 6 });
  return new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
}

/** A JAR-shaped archive (ZIP with the extension manifest stand-in, a JAR manifest and a class stand-in; no dex). Signature checking for JARs happens in the JVM. */
export function createSyntheticJar(seed = 'synthetic-jar') {
  const zip = createZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('binary-manifest-placeholder:' + seed) },
    { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\nCreated-By: synthetic test generator\n') },
    { name: 'example/Extension.class', data: Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from(seed)]) },
  ], { epochSeconds: 1792540800, level: 6 });
  return new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
}

/** Offset of the first stored/compressed byte of classes.dex (for tampering tests). */
export function classesDexDataOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && !(view.getUint32(eocd, true) === 0x06054b50 && eocd + 22 + view.getUint16(eocd + 20, true) === bytes.length)) eocd--;
  if (eocd < 0) throw new Error('ZIP end record not found');
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < view.getUint16(eocd + 10, true); index++) {
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    if (new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)) === 'classes.dex') {
      const local = view.getUint32(offset + 42, true);
      return local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('classes.dex not found');
}
