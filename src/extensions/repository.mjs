/* MPL-2.0. Wire schema follows Suwayomi's NetworkExtensionStore and legacy
 * repository models. This parses catalogues; it does not authenticate APKs. */
import { sourceFetch, decodeBytes } from './transport.mjs';

const limit = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const looksJson = bytes => { const first = bytes.find(byte => ![9, 10, 13, 32].includes(byte)); return first === 123 || first === 91; };
function parseJson(bytes) {
  // Legacy catalogues encode long IDs as JSON numbers. Quote only unsafe
  // integer tokens, never digits inside strings, before native JSON parsing.
  const input = decoder.decode(bytes); let output = '', quoted = false, escaped = false;
  for (let offset = 0; offset < input.length; offset++) {
    const char = input[offset];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === '-' || /\d/.test(char)) {
      const token = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(offset))?.[0];
      if (!token) { output += char; continue; }
      output += /^-?(0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
      offset += token.length - 1;
    } else output += char;
  }
  return JSON.parse(output);
}
export function repositoryUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Repository URLs must be HTTP(S) without embedded credentials');
  url.hash = '';
  if (url.protocol === 'https:' && url.hostname === 'github.com') {
    const raw = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/.exec(url.pathname);
    if (raw) { url.hostname = 'raw.githubusercontent.com'; url.pathname = `/${raw[1]}/${raw[2]}/${raw[3]}`; }
  }
  return url.href;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.length || value.length > 2 * 1024 * 1024) throw new Error('Invalid repository ' + name);
  return value;
}
function integer(value, name, signed = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe numeric repository ' + name + '; use a decimal string');
  if (!/^-?\d+$/.test(String(value))) throw new Error('Invalid repository ' + name);
  const number = BigInt(value);
  if (number < (signed ? -(1n << 63n) : 0n) || number >= (signed ? 1n << 63n : 1n << 64n)) throw new Error('Out-of-range repository ' + name);
  return number.toString();
}
function fields(bytes) {
  let offset = 0;
  const result = new Map();
  function varint() {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('Truncated repository protobuf');
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error('Oversized protobuf integer');
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return result;
    }
    throw new Error('Oversized protobuf integer');
  }
  while (offset < bytes.length) {
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number || number > 536870911) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const size = Number(varint());
      if (!Number.isSafeInteger(size) || size > bytes.length - offset) throw new Error('Truncated protobuf message');
      value = bytes.subarray(offset, offset + size); offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Truncated protobuf fixed field');
      continue;
    } else throw new Error('Unsupported protobuf wire type');
    if (!result.has(number)) result.set(number, []);
    result.get(number).push(value);
  }
  return result;
}
const values = (fields, key) => fields.get(key) || [];
function message(value) { if (!(value instanceof Uint8Array)) throw new Error('Expected protobuf message'); return fields(value); }
function string(value, fallback = '') { if (value == null) return fallback; if (!(value instanceof Uint8Array)) throw new Error('Expected protobuf string'); return decoder.decode(value); }
const first = (fields, key) => values(fields, key).at(-1);
const str = (fields, key, fallback) => string(first(fields, key), fallback);
function num(fields, key, fallback = 0n) { const value = first(fields, key) ?? fallback; if (typeof value !== 'bigint') throw new Error('Expected protobuf integer'); return value; }
function protoExtension(bytes) {
  const f = message(bytes), r = message(first(f, 3));
  return { name: str(f, 1), packageName: str(f, 2), resources: { apkUrl: str(r, 1), iconUrl: str(r, 2), jarUrl: str(r, 501) },
    extensionLib: str(f, 4), versionCode: num(f, 5).toString(), versionName: str(f, 6), contentWarning: Number(num(f, 7)),
    sources: values(f, 8).map(bytes => { const s = message(bytes); return { id: BigInt.asIntN(64, num(s, 1)).toString(), name: str(s, 2), language: str(s, 3), homeUrl: str(s, 4), message: str(s, 7) || null }; }),
  };
}
function warning(value) {
  if (typeof value === 'number') return ['SAFE', 'SAFE', 'MIXED', 'NSFW'][value] || 'MIXED';
  const name = String(value || 'SAFE').replace('CONTENT_WARNING_', '');
  return name === 'UNSPECIFIED' ? 'SAFE' : ['SAFE', 'MIXED', 'NSFW'].includes(name) ? name : 'MIXED';
}
function extension(value, base, legacy = false) {
  const packageName = text(value.packageName || value.pkg, 'package name');
  if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(packageName)) throw new Error('Invalid extension package name');
  const resources = value.resources || {};
  if (legacy && !/^[\w.-]+\.apk$/.test(value.apk || '')) throw new Error('Invalid legacy APK filename');
  const versionCode = integer(value.versionCode ?? value.code, 'version code');
  const versionName = text(value.versionName || value.version, 'version name');
  const sources = (value.sources || []).map(source => ({ id: integer(source.id, 'source ID', true), name: text(source.name, 'source name'), lang: text(source.language || source.lang, 'language'), baseUrl: source.homeUrl || source.baseUrl || '', message: source.message || null }));
  return { packageName, name: text(value.name, 'extension name').replace(/^Tachiyomi: /, ''), versionCode, version: versionName,
    libraryVersion: text(value.extensionLib || versionName.split('.').slice(0, -1).join('.'), 'extension API'),
    apkUrl: repositoryUrl(legacy ? 'apk/' + value.apk : text(resources.apkUrl, 'APK URL'), base),
    jarUrl: resources.jarUrl ? repositoryUrl(resources.jarUrl, base) : null,
    iconUrl: resources.iconUrl ? repositoryUrl(resources.iconUrl, base) : legacy ? repositoryUrl('icon/' + packageName + '.png', base) : '',
    contentWarning: legacy ? value.nsfw === 1 ? 'MIXED' : 'SAFE' : warning(value.contentWarning), sources,
    lang: new Set(sources.map(source => source.lang)).size === 1 ? sources[0].lang : value.lang || 'all',
  };
}
async function unpack(bytes) {
  if (bytes.length > limit) throw new Error('Repository index exceeds 32 MiB');
  if (bytes[0] !== 31 || bytes[1] !== 139) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Expanded repository index exceeds 32 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
/** Supports gzipped protobuf v2, JSON v2, repo.json indirection and legacy lists. */
export async function fetchRepository(input, transport = sourceFetch) {
  const seen = new Set();
  async function load(url) {
    url = repositoryUrl(url);
    if (seen.has(url) || seen.size >= 4) throw new Error('Repository indirection cycle or depth limit');
    seen.add(url);
    const response = await transport({ url, method: 'GET', headers: [] });
    if (response.error || response.status < 200 || response.status >= 300) throw new Error('Repository fetch failed: ' + (response.error || 'HTTP ' + response.status));
    // Base64 is the shared browser/JVM transport boundary; bound before decoding.
    if (typeof response.body !== 'string' || response.body.length > Math.ceil(limit / 3) * 4) throw new Error('Repository download exceeds 32 MiB');
    return unpack(decodeBytes(response.body));
  }
  let url = repositoryUrl(input), raw = await load(url), root, legacyList;
  while (true) {
    if (looksJson(raw)) {
      root = parseJson(raw);
      if (Array.isArray(root) && new URL(url).pathname.endsWith('/index.min.json')) {
        legacyList = root;
        url = repositoryUrl('repo.json', url); raw = await load(url); continue;
      }
      if (root.index_v2) { url = repositoryUrl(root.index_v2, url); raw = await load(url); continue; }
      if (root.meta) {
        const meta = root.meta, listUrl = repositoryUrl('index.min.json', url);
        const list = legacyList || parseJson(await load(listUrl));
        if (!Array.isArray(list)) throw new Error('Legacy repository list is invalid');
        return finish({ name: meta.name, badgeLabel: meta.shortName || meta.name, signingKey: meta.signingKeyFingerprint || '', contact: { website: meta.website } }, list, true);
      }
      if (Array.isArray(root)) return finish({ name: new URL(url).hostname, badgeLabel: '', signingKey: '', contact: {} }, root, true);
    } else {
      const f = fields(raw), contact = first(f, 4) ? message(first(f, 4)) : new Map();
      root = { name: str(f, 1), badgeLabel: str(f, 2), signingKey: str(f, 3), contact: { website: str(contact, 1), discord: str(contact, 2) }, extensionListUrl: str(f, 102) || null };
      if (first(f, 101)) root.extensionList = { extensions: values(message(first(f, 101)), 1).map(protoExtension) };
    }
    let extensions = root.extensionList?.extensions;
    if (root.extensionListUrl) {
      const bytes = await load(repositoryUrl(root.extensionListUrl, url));
      extensions = looksJson(bytes)
        ? parseJson(bytes).extensions : values(fields(bytes), 1).map(protoExtension);
    }
    if (!Array.isArray(extensions)) throw new Error('Repository has no extension list');
    return finish(root, extensions, false);
  }
  function finish(root, list, legacy) {
    if (list.length > 20000) throw new Error('Repository has too many extensions');
    const extensions = list.map(value => extension(value, url, legacy));
    if (new Set(extensions.map(value => value.packageName)).size !== extensions.length) throw new Error('Duplicate repository package name');
    if (root.signingKey != null && typeof root.signingKey !== 'string') throw new Error('Invalid repository signing identity');
    return { indexUrl: url, name: text(root.name, 'name'), badgeLabel: text(root.badgeLabel || root.name, 'badge'),
      signingKey: root.signingKey || '', contactWebsite: root.contact?.website ? repositoryUrl(root.contact.website, url) : null, contactDiscord: root.contact?.discord ? repositoryUrl(root.contact.discord, url) : null,
      isLegacy: legacy, extensionListUrl: root.extensionListUrl ? repositoryUrl(root.extensionListUrl, url) : null,
      extensions, fetchedAt: Date.now(),
    };
  }
}
