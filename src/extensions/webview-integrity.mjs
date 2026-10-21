const HASH_ALGORITHMS = new Map([
  ['sha256', 'SHA-256'],
  ['sha384', 'SHA-384'],
  ['sha512', 'SHA-512'],
]);

const HASH_STRENGTH = new Map([['sha256', 1], ['sha384', 2], ['sha512', 3]]);

export function parseSubresourceIntegrity(metadata) {
  const parsed = [];
  for (const token of String(metadata || '').split(/[\t\n\f\r ]+/)) {
    if (!token) continue;
    const expression = token.split('?', 1)[0];
    const separator = expression.indexOf('-');
    if (separator < 0) continue;
    const algorithm = expression.slice(0, separator).toLowerCase();
    if (!HASH_ALGORITHMS.has(algorithm)) continue;
    parsed.push({ algorithm, digest: expression.slice(separator + 1) });
  }
  return parsed;
}

export async function verifySubresourceIntegrity(bytes, metadata, subtle = globalThis.crypto?.subtle) {
  const parsed = parseSubresourceIntegrity(metadata);
  // SRI treats metadata containing no recognized algorithms as though no
  // integrity metadata had been provided, allowing algorithm agility.
  if (!parsed.length) return true;
  if (!subtle?.digest) throw new Error('Subresource Integrity requires Web Crypto SHA-2 support.');
  const strongest = Math.max(...parsed.map(item => HASH_STRENGTH.get(item.algorithm)));
  const expected = parsed.filter(item => HASH_STRENGTH.get(item.algorithm) === strongest);
  const algorithm = expected[0].algorithm;
  const digest = await subtle.digest(HASH_ALGORITHMS.get(algorithm), bytes);
  const actual = bytesToBase64(new Uint8Array(digest));
  return expected.some(item => item.digest === actual);
}

export function corsResponseAllowed(response, { documentOrigin, resourceUrl, credentialsMode = 'same-origin' } = {}) {
  let url;
  try { url = new URL(resourceUrl); } catch { return false; }
  if (url.origin === documentOrigin) return true;
  const allowedOrigins = getHeaderValues(response?.headers, 'access-control-allow-origin');
  if (allowedOrigins.length !== 1) return false;
  const allowed = allowedOrigins[0].trim();
  if (credentialsMode === 'include') {
    const allowedCredentials = getHeaderValues(response?.headers, 'access-control-allow-credentials');
    return allowed === documentOrigin && allowedCredentials.length === 1 && allowedCredentials[0].trim().toLowerCase() === 'true';
  }
  return allowed === '*' || allowed === documentOrigin;
}

function getHeaderValues(headers, wanted) {
  const values = [];
  for (const [name, value] of headers || [])
    if (String(name).toLowerCase() === wanted) values.push(String(value));
  return values;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
