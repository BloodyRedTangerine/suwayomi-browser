const APK_V2_BLOCK_ID = 0x7109871a;
const APK_V3_BLOCK_ID = 0xf05368c0;
const APK_V31_BLOCK_ID = 0x1b93ad61;
const APK_V2_STRIPPING_PROTECTION_ATTR_ID = 0xbeeff00d;
const APK_SIG_MAGIC = new TextEncoder().encode('APK Sig Block 42');
const CHUNK_SIZE = 1 << 20;

const SIGNATURE_ALGORITHMS = new Map([
  [0x0101, { name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32, strength: 20 }],
  [0x0102, { name: 'RSA-PSS', hash: 'SHA-512', saltLength: 64, strength: 40 }],
  [0x0103, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', strength: 10 }],
  [0x0104, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512', strength: 30 }],
  [0x0201, { name: 'ECDSA', hash: 'SHA-256', strength: 15 }],
  [0x0202, { name: 'ECDSA', hash: 'SHA-512', strength: 35 }],
]);

function fail(message) { throw new Error(`APK signature verification failed: ${message}`); }

function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) fail('truncated ZIP structure');
  return dataView(bytes).getUint16(offset, true);
}
function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) fail('truncated ZIP structure');
  return dataView(bytes).getUint32(offset, true);
}
function u64(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.length) fail('truncated APK signing block');
  const value = dataView(bytes).getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('APK signing block is too large');
  return Number(value);
}
function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function hex(bytes) { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }

function findEocd(bytes) {
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (u32(bytes, offset) !== 0x06054b50) continue;
    const commentLength = u16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  fail('ZIP End of Central Directory was not found or has trailing data');
}

function locateApkSections(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 22) fail('APK is truncated');
  const eocdOffset = findEocd(bytes);
  if (u16(bytes, eocdOffset + 4) !== 0 || u16(bytes, eocdOffset + 6) !== 0)
    fail('multi-disk ZIP APKs are unsupported');
  const diskEntries = u16(bytes, eocdOffset + 8);
  const entries = u16(bytes, eocdOffset + 10);
  const centralDirectorySize = u32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = u32(bytes, eocdOffset + 16);
  if (diskEntries !== entries || entries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff)
    fail('ZIP64 or split APK structures are unsupported');
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset)
    fail('central directory is not immediately before the ZIP end record');
  if (entries && (centralDirectorySize < 46 || u32(bytes, centralDirectoryOffset) !== 0x02014b50))
    fail('central directory structure is malformed');
  if (centralDirectoryOffset < 24) fail('APK signing block footer is missing');
  if (!equalBytes(bytes.subarray(centralDirectoryOffset - 16, centralDirectoryOffset), APK_SIG_MAGIC))
    fail('APK signing block magic is missing');
  const blockSize = u64(bytes, centralDirectoryOffset - 24);
  if (blockSize + 8 > centralDirectoryOffset) fail('APK signing block size is out of range');
  const blockStart = centralDirectoryOffset - blockSize - 8;
  if (u64(bytes, blockStart) !== blockSize) fail('APK signing block size fields do not match');
  const pairStart = blockStart + 8;
  const pairEnd = centralDirectoryOffset - 24;
  let cursor = pairStart;
  let v2 = null;
  let unsupportedScheme = 0;
  while (cursor < pairEnd) {
    if (cursor + 8 > pairEnd) fail('truncated APK signing block pair length');
    const pairLength = u64(bytes, cursor);
    if (pairLength < 4 || pairLength > pairEnd - cursor - 8) fail('APK signing block pair is out of range');
    const id = u32(bytes, cursor + 8);
    const value = bytes.subarray(cursor + 12, cursor + 8 + pairLength);
    if (id === APK_V2_BLOCK_ID) {
      if (v2) fail('duplicate APK v2 signature blocks');
      v2 = value;
    }
    if (id === APK_V3_BLOCK_ID) unsupportedScheme = 3;
    if (id === APK_V31_BLOCK_ID) unsupportedScheme = 31;
    cursor += 8 + pairLength;
  }
  if (cursor !== pairEnd) fail('APK signing block pairs are malformed');
  if (unsupportedScheme) fail(`APK v${unsupportedScheme === 31 ? '3.1' : '3'} signatures are present but not supported; refusing v2 fallback`);
  if (!v2) fail('APK v2 signature block is missing');

  const eocd = bytes.slice(eocdOffset);
  dataView(eocd).setUint32(16, blockStart, true);
  return { blockStart, centralDirectoryOffset, eocdOffset, sections: [bytes.subarray(0, blockStart), bytes.subarray(centralDirectoryOffset, eocdOffset), eocd], v2 };
}

function readLengthPrefixed(bytes, offset, limit, label) {
  if (offset + 4 > limit) fail(`truncated ${label} length`);
  const length = u32(bytes, offset);
  const start = offset + 4;
  const end = start + length;
  if (end > limit || end < start) fail(`${label} is out of range`);
  return { value: bytes.subarray(start, end), next: end };
}

function readSequence(bytes, label, parseItem) {
  const items = [];
  let offset = 0;
  while (offset < bytes.length) {
    const item = readLengthPrefixed(bytes, offset, bytes.length, label);
    items.push(parseItem(item.value));
    offset = item.next;
  }
  if (offset !== bytes.length) fail(`${label} sequence is malformed`);
  return items;
}

function parseAlgorithmRecord(value, label) {
  if (value.length < 4) fail(`${label} algorithm record is truncated`);
  const id = u32(value, 0);
  const payload = readLengthPrefixed(value, 4, value.length, `${label} value`);
  if (payload.next !== value.length) fail(`${label} algorithm record has trailing data`);
  return { id, value: payload.value };
}

function parseV2Signers(v2) {
  const signerSequence = readLengthPrefixed(v2, 0, v2.length, 'signer sequence');
  if (signerSequence.next !== v2.length) fail('v2 block has trailing data');
  return readSequence(signerSequence.value, 'signer', signerBytes => {
    let offset = 0;
    const signedDataField = readLengthPrefixed(signerBytes, offset, signerBytes.length, 'signed data');
    offset = signedDataField.next;
    const signaturesField = readLengthPrefixed(signerBytes, offset, signerBytes.length, 'signature sequence');
    offset = signaturesField.next;
    const publicKeyField = readLengthPrefixed(signerBytes, offset, signerBytes.length, 'signer public key');
    offset = publicKeyField.next;
    if (offset !== signerBytes.length) fail('signer record has trailing data');

    let dataOffset = 0;
    const digestsField = readLengthPrefixed(signedDataField.value, dataOffset, signedDataField.value.length, 'digest sequence');
    dataOffset = digestsField.next;
    const certificatesField = readLengthPrefixed(signedDataField.value, dataOffset, signedDataField.value.length, 'certificate sequence');
    dataOffset = certificatesField.next;
    const attributesField = readLengthPrefixed(signedDataField.value, dataOffset, signedDataField.value.length, 'additional attributes');
    dataOffset = attributesField.next;
    if (dataOffset < signedDataField.value.length) {
      const reservedField = readLengthPrefixed(signedDataField.value, dataOffset, signedDataField.value.length, 'reserved signed-data field');
      if (reservedField.value.length !== 0 || reservedField.next !== signedDataField.value.length)
        fail('signed data has unexpected trailing fields');
      dataOffset = reservedField.next;
    }
    if (dataOffset !== signedDataField.value.length) fail('signed data has unexpected trailing fields');

    const digests = readSequence(digestsField.value, 'digest record', value => parseAlgorithmRecord(value, 'digest'));
    const certificates = readSequence(certificatesField.value, 'certificate', value => value);
    const signatures = readSequence(signaturesField.value, 'signature record', value => parseAlgorithmRecord(value, 'signature'));
    if (!certificates.length) fail('signer certificate chain is empty');
    if (!signatures.length || !digests.length) fail('signer has no signatures or digests');
    for (const attribute of readSequence(attributesField.value, 'additional attribute', value => value)) {
      if (attribute.length < 4) fail('additional attribute is truncated');
      if (u32(attribute, 0) === APK_V2_STRIPPING_PROTECTION_ATTR_ID) {
        if (attribute.length !== 8) fail('signature-scheme stripping protection attribute is malformed');
        const requiredScheme = u32(attribute, 4);
        if (requiredScheme > 2)
          fail(`APK indicates required v${requiredScheme === 31 ? '3.1' : requiredScheme} signature protection, which is unsupported`);
      }
    }
    if (signatures.some(record => record.value.length === 0) || digests.some(record => record.value.length === 0))
      fail('signer contains an empty signature or digest');
    if (signatures.some((record, index) => record.id !== digests[index]?.id) || signatures.length !== digests.length)
      fail('signature and digest algorithm lists do not match');
    return { signedData: signedDataField.value, publicKey: publicKeyField.value, certificates, digests, signatures };
  });
}

function readDer(bytes, offset, limit) {
  if (offset + 2 > limit) fail('certificate DER is truncated');
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  let headerLength = 2;
  let length = firstLength;
  if (firstLength & 0x80) {
    const count = firstLength & 0x7f;
    if (!count || count > 4 || offset + 2 + count > limit) fail('certificate DER length is invalid');
    if (bytes[offset + 2] === 0) fail('certificate DER length is not canonical');
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[offset + 2 + index];
    if (length < 0x80) fail('certificate DER length is not canonical');
    headerLength += count;
  }
  const contentStart = offset + headerLength;
  const end = contentStart + length;
  if (end > limit || end < contentStart) fail('certificate DER value is out of range');
  return { tag, start: offset, contentStart, end };
}

function certificateSpki(certificate) {
  const outer = readDer(certificate, 0, certificate.length);
  if (outer.tag !== 0x30 || outer.end !== certificate.length) fail('signer certificate is not one DER sequence');
  const tbs = readDer(certificate, outer.contentStart, outer.end);
  if (tbs.tag !== 0x30) fail('signer certificate has no TBSCertificate');
  let offset = tbs.contentStart;
  let field = readDer(certificate, offset, tbs.end);
  if (field.tag === 0xa0) { offset = field.end; field = readDer(certificate, offset, tbs.end); }
  if (field.tag !== 0x02) fail('signer certificate serial number is malformed');
  offset = field.end;
  for (let index = 0; index < 4; index++) {
    field = readDer(certificate, offset, tbs.end);
    if (field.tag !== 0x30) fail('signer certificate fields are malformed');
    offset = field.end;
  }
  const spki = readDer(certificate, offset, tbs.end);
  if (spki.tag !== 0x30) fail('signer certificate has no SubjectPublicKeyInfo');
  return certificate.subarray(spki.start, spki.end);
}

function derEcdsaToP1363(signature, componentLength) {
  const sequence = readDer(signature, 0, signature.length);
  if (sequence.tag !== 0x30 || sequence.end !== signature.length) fail('ECDSA signature is not a DER sequence');
  const r = readDer(signature, sequence.contentStart, sequence.end);
  const s = readDer(signature, r.end, sequence.end);
  if (r.tag !== 0x02 || s.tag !== 0x02 || s.end !== sequence.end) fail('ECDSA signature integers are malformed');
  const raw = new Uint8Array(componentLength * 2);
  const copyInteger = (integer, targetOffset) => {
    let value = signature.subarray(integer.contentStart, integer.end);
    if (!value.length || (value[0] & 0x80)) fail('ECDSA signature integer is negative or empty');
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > componentLength) fail('ECDSA signature integer is out of range');
    raw.set(value, targetOffset + componentLength - value.length);
  };
  copyInteger(r, 0);
  copyInteger(s, componentLength);
  return raw;
}

async function importVerifierKey(algorithm, spki) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('WebCrypto is unavailable');
  if (algorithm.name !== 'ECDSA') {
    const key = await subtle.importKey('spki', spki, { name: algorithm.name, hash: algorithm.hash }, false, ['verify']);
    return { key, verifyAlgorithm: algorithm, componentLength: 0 };
  }
  let lastError;
  for (const [namedCurve, componentLength] of [['P-256', 32], ['P-384', 48], ['P-521', 66]]) {
    try {
      const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
      return { key, verifyAlgorithm: { name: 'ECDSA', hash: algorithm.hash }, componentLength };
    } catch (error) { lastError = error; }
  }
  throw new Error(`APK signature verification failed: unsupported ECDSA public key (${lastError?.name || 'invalid'})`);
}

async function verifySignedData(signer) {
  const choices = signer.signatures
    .map((record, index) => ({ ...record, digest: signer.digests[index].value, algorithm: SIGNATURE_ALGORITHMS.get(record.id) }))
    .filter(record => record.algorithm)
    .sort((left, right) => right.algorithm.strength - left.algorithm.strength);
  if (!choices.length) fail('no supported APK v2 signature algorithms');
  const choice = choices[0];
  const { key, verifyAlgorithm, componentLength } = await importVerifierKey(choice.algorithm, signer.publicKey);
  const signature = choice.algorithm.name === 'ECDSA' ? derEcdsaToP1363(choice.value, componentLength) : choice.value;
  let valid;
  try {
    const verifyParams = choice.algorithm.name === 'RSA-PSS'
      ? { name: 'RSA-PSS', saltLength: choice.algorithm.saltLength }
      : choice.algorithm.name === 'ECDSA'
        ? { name: 'ECDSA', hash: choice.algorithm.hash }
        : { name: choice.algorithm.name };
    valid = await globalThis.crypto.subtle.verify(verifyParams, key, signature, signer.signedData);
  } catch (error) { throw new Error(`APK signature verification failed: signature primitive rejected (${error?.name || 'error'})`); }
  if (!valid) fail('signer signature is invalid');
  const expectedLength = choice.algorithm.hash === 'SHA-256' ? 32 : 64;
  if (choice.digest.length !== expectedLength) fail('signed content digest has the wrong length');
  return choice;
}

async function contentDigest(sections, hash) {
  const digests = [];
  for (const section of sections) {
    for (let offset = 0; offset < section.length; offset += CHUNK_SIZE) {
      const chunk = section.subarray(offset, Math.min(offset + CHUNK_SIZE, section.length));
      const input = new Uint8Array(5 + chunk.length);
      input[0] = 0xa5;
      dataView(input).setUint32(1, chunk.length, true);
      input.set(chunk, 5);
      digests.push(new Uint8Array(await globalThis.crypto.subtle.digest(hash, input)));
    }
  }
  if (!digests.length) fail('APK has no digestible signed content');
  const topLevel = new Uint8Array(5 + digests.reduce((total, digest) => total + digest.length, 0));
  topLevel[0] = 0x5a;
  dataView(topLevel).setUint32(1, digests.length, true);
  let offset = 5;
  for (const digest of digests) { topLevel.set(digest, offset); offset += digest.length; }
  return new Uint8Array(await globalThis.crypto.subtle.digest(hash, topLevel));
}

/** Verify APK Signature Scheme v2 and return the leaf signer certificate fingerprints. */
export async function verifyApkV2Signature(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sections = locateApkSections(bytes);
  const signers = parseV2Signers(sections.v2);
  if (!signers.length) fail('v2 signature block has no signers');
  const fingerprints = [];
  const verifiedAlgorithmIds = [];
  for (const signer of signers) {
    const choice = await verifySignedData(signer);
    verifiedAlgorithmIds.push(choice.id);
    const certificate = signer.certificates[0];
    if (!equalBytes(certificateSpki(certificate), signer.publicKey))
      fail('signer public key does not match the leaf certificate');
    const digest = await contentDigest(sections.sections, choice.algorithm.hash);
    if (!equalBytes(digest, choice.digest)) fail('APK content digest does not match the signed digest');
    fingerprints.push(hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', certificate))));
  }
  return { scheme: 'apk-v2', fingerprints: [...new Set(fingerprints)], signatureAlgorithmIds: verifiedAlgorithmIds };
}

export function parseJarV1Verification(result) {
  const match = /^jar-v1:([a-f0-9]{64})$/i.exec(String(result));
  if (!match) throw new Error('JAR-v1 verifier returned an invalid signer fingerprint');
  return { scheme: 'jar-v1', fingerprints: [match[1].toLowerCase()] };
}

export async function verifyExtensionSignature(input, { format, jarVerifier } = {}) {
  if (format === 'apk') return verifyApkV2Signature(input);
  if (format !== 'jar') throw new Error(`Unsupported extension signature format: ${format || 'unknown'}`);
  if (typeof jarVerifier !== 'function') throw new Error('JAR-v1 verifier is unavailable');
  return parseJarV1Verification(await jarVerifier(input));
}
