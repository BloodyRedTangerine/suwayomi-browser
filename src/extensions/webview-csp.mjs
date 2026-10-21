const DIRECTIVE_FALLBACKS = Object.freeze({
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
});

export function readContentSecurityPolicies(document) {
  return [...document.querySelectorAll('meta[http-equiv]')]
    .filter(node => String(node.getAttribute('http-equiv') || '').trim().toLowerCase() === 'content-security-policy')
    .map(node => String(node.getAttribute('content') || ''));
}

export function upgradeInsecureRequestUrl(policies, resourceUrl) {
  let target;
  try { target = new URL(resourceUrl); }
  catch { return String(resourceUrl ?? ''); }
  if (target.protocol !== 'http:' || !policies.some(policy => parsePolicy(policy).has('upgrade-insecure-requests'))) return target.href;
  target.protocol = 'https:';
  if (target.port === '80') target.port = '443';
  return target.href;
}

export function snapshotContentSecurityPolicies(document) {
  const policiesByElement = new WeakMap();
  const activePolicies = [];
  for (const node of document.querySelectorAll('*')) {
    policiesByElement.set(node, activePolicies.slice());
    if (node.tagName?.toLowerCase() === 'meta'
      && String(node.getAttribute('http-equiv') || '').trim().toLowerCase() === 'content-security-policy')
      activePolicies.push(String(node.getAttribute('content') || ''));
  }
  return { policies: activePolicies, policiesByElement };
}

/**
 * Allow only the exact inline scripts generated while translating brokered
 * resources. Original policy strings remain available to the request broker.
 */
export async function authorizeGeneratedInlineScripts(document, scripts, cryptoProvider = globalThis.crypto) {
  const code = [...new Set((scripts || []).map(script => String(script)))];
  if (!code.length) return [];
  if (!cryptoProvider?.subtle?.digest || typeof globalThis.btoa !== 'function')
    throw new Error('WebView generated-script CSP hashes require Web Crypto and base64 support.');

  const hashes = [...new Set(await Promise.all(code.map(async script => {
    const digest = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(script)));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return `'sha256-${globalThis.btoa(binary)}'`;
  })))];

  for (const node of document.querySelectorAll('meta[http-equiv]')) {
    if (String(node.getAttribute('http-equiv') || '').trim().toLowerCase() !== 'content-security-policy') continue;
    const serialized = String(node.getAttribute('content') || '');
    const directives = parsePolicy(serialized);
    const scriptDirective = ['script-src-elem', 'script-src', 'default-src'].find(name => directives.has(name));
    if (!scriptDirective) continue;

    const sources = directives.get(scriptDirective);
    const hasNonceOrHash = sources.some(source => /^'(?:nonce-[A-Za-z0-9+/_=-]+|sha(?:256|384|512)-[A-Za-z0-9+/_=-]+)'$/i.test(source));
    // CSP3 ignores unsafe-inline in the presence of a nonce/hash. Otherwise
    // it already permits the generated scripts, and adding a hash would
    // unexpectedly disable that existing behavior in CSP3 browsers.
    if (!hasNonceOrHash && sources.some(source => source.toLowerCase() === "'unsafe-inline'")) continue;
    const missing = hashes.filter(hash => !sources.includes(hash));
    if (!missing.length) continue;

    let updated = false;
    const amended = serialized.split(';').map(raw => {
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (updated || tokens.shift()?.toLowerCase() !== scriptDirective) return raw;
      updated = true;
      const trailingWhitespace = raw.match(/\s*$/)?.[0] || '';
      const body = raw.slice(0, raw.length - trailingWhitespace.length);
      return `${body}${body.trim() ? ' ' : ''}${missing.join(' ')}${trailingWhitespace}`;
    }).join(';');
    if (updated) node.setAttribute('content', amended);
  }
  return hashes;
}

/** Conservative request-time CSP check for resources fetched outside the iframe. */
export function isCspRequestAllowed({ policies = [], baseUrl, resourceUrl, directive, nonce = '', integrity = '' } = {}) {
  const fallbacks = DIRECTIVE_FALLBACKS[directive];
  if (!fallbacks) return false;
  let target, self;
  try { target = new URL(resourceUrl); self = new URL(baseUrl); }
  catch { return false; }
  if (!['http:', 'https:'].includes(target.protocol)) return false;

  for (const serialized of policies) {
    const directives = parsePolicy(serialized);
    let sources;
    for (const name of fallbacks) {
      if (directives.has(name)) { sources = directives.get(name); break; }
    }
    if (!sources) continue;
    if (nonce && sources.some(source => nonceMatches(source, nonce))) continue;
    if (integrity && integrityMatches(sources, integrity)) continue;
    if (directive === 'script-src-elem' && sources.some(source => source.toLowerCase() === "'strict-dynamic'")) return false;
    if (!sources.some(source => sourceMatchesUrl(source, target, self))) return false;
  }
  return true;
}

function parsePolicy(serialized) {
  const directives = new Map();
  for (const raw of String(serialized || '').split(';')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens.shift().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || directives.has(name)) continue;
    directives.set(name, tokens);
  }
  return directives;
}

function nonceMatches(source, nonce) {
  const match = /^'nonce-([A-Za-z0-9+/_=-]+)'$/i.exec(source);
  return Boolean(match && match[1] === nonce);
}

function integrityMatches(sources, metadata) {
  const allowed = new Set(sources.map(source => {
    const match = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)'$/i.exec(source);
    return match ? `${match[1].toLowerCase()}-${match[2]}` : '';
  }).filter(Boolean));
  const hashes = String(metadata).trim().split(/\s+/).map(value => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)(?:\?.*)?$/i.exec(value);
    return match ? `${match[1].toLowerCase()}-${match[2]}` : '';
  }).filter(Boolean);
  return hashes.length > 0 && hashes.every(hash => allowed.has(hash));
}

function sourceMatchesUrl(expression, target, self) {
  const source = String(expression || '').trim();
  const lower = source.toLowerCase();
  if (lower === "'self'") return selfMatches(target, self);
  if (!source || lower.startsWith("'") || lower === 'none') return false;
  if (source === '*') return target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === self.protocol;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return schemeMatches(source.slice(0, -1).toLowerCase(), target.protocol.slice(0, -1));
  const parsed = parseHostSource(source);
  if (!parsed) return false;
  const sourceScheme = parsed.scheme || self.protocol.slice(0, -1);
  if (!schemeMatches(sourceScheme, target.protocol.slice(0, -1))) return false;
  if (!hostMatches(parsed.host, target.hostname)) return false;
  if (!portMatches(parsed.port, target)) return false;
  if (parsed.path && !pathMatches(parsed.path, target.pathname)) return false;
  return true;
}

function parseHostSource(source) {
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)(\/[^?#]*)?$/i.exec(source);
  if (!match) return null;
  let authority = match[2];
  let port = null;
  const portMatch = /^(.*):(\*|[0-9]+)$/.exec(authority);
  if (portMatch) { authority = portMatch[1]; port = portMatch[2]; }
  if (!authority || authority.includes(':') || authority.includes('@') || authority.includes('[') || authority.includes(']')) return null;
  if (authority !== '*' && !authority.startsWith('*.') && !/^[a-z0-9.-]+$/i.test(authority)) return null;
  if (authority.includes('*') && authority !== '*' && !authority.startsWith('*.')) return null;
  return { scheme: match[1]?.toLowerCase() || '', host: authority.toLowerCase(), port, path: match[3] || '' };
}

function schemeMatches(source, target) {
  if (source === target) return true;
  return source === 'http' && target === 'https';
}

function hostMatches(pattern, host) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return host.toLowerCase().endsWith(pattern.slice(1));
  return pattern === host.toLowerCase();
}

function portMatches(sourcePort, target) {
  if (sourcePort === '*') return true;
  if (sourcePort !== null) return Number(sourcePort) === Number(target.port || defaultPort(target.protocol));
  return !target.port || Number(target.port) === defaultPort(target.protocol);
}

function defaultPort(protocol) {
  return protocol === 'http:' ? 80 : protocol === 'https:' ? 443 : -1;
}

function selfMatches(target, self) {
  if (target.origin === self.origin) return true;
  return self.protocol === 'http:' && target.protocol === 'https:' && self.hostname === target.hostname
    && (self.port === target.port || (!self.port && !target.port));
}

function pathMatches(sourcePath, targetPath) {
  let sourceParts, targetParts;
  try {
    sourceParts = sourcePath.split('/').map(decodeURIComponent);
    targetParts = targetPath.split('/').map(decodeURIComponent);
  } catch { return false; }
  const prefix = sourcePath.endsWith('/');
  if (sourceParts.length > targetParts.length || (!prefix && sourceParts.length !== targetParts.length)) return false;
  if (prefix) sourceParts.pop();
  return sourceParts.every((part, index) => part === targetParts[index]);
}
