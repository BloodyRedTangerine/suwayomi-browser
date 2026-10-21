import { registrableDomain } from './public-suffix.mjs';
import { hostPermissionOrigin } from './platform.mjs';

// Browser host permissions are origin-scoped. Source home URLs can contain a
// path, but requesting the origin pattern is the narrowest permission Chrome
// and Firefox can grant for an extension source.
export function permissionPattern(value, browser = globalThis.chrome) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[*%]/.test(url.hostname)) return null;
    return `${hostPermissionOrigin(url, browser)}/*`;
  } catch {
    return null;
  }
}

export function permissionGrantPattern(value) {
  const exact = permissionPattern(value);
  if (!exact) return null;
  const url = new URL(exact), domain = registrableDomain(url.hostname);
  return domain && domain !== url.hostname.replace(/\.$/, '') ? `${url.protocol}//*.${domain}/*` : exact;
}

export function safePermissionGrant(pattern) {
  if (typeof pattern !== 'string') return false;
  const match = /^(https?):\/\/\*\.([^/:*]+)\/\*$/.exec(pattern);
  if (match) return registrableDomain(match[2]) === match[2];
  return permissionPattern(pattern) === pattern;
}

export function permissionCovers(pattern, value) {
  if (!safePermissionGrant(pattern)) return false;
  const exact = permissionPattern(value);
  if (!exact) return false;
  const wildcard = /^(https?):\/\/\*\.([^/:*]+)\/\*$/.exec(pattern);
  if (!wildcard) return new URL(pattern).origin === new URL(exact).origin;
  // Chromium URL encodes '*' in hostnames as %2A; Node's URL does not.
  // Match-pattern syntax is not a URL and must be parsed as a pattern.
  const url = new URL(exact), domain = wildcard[2], host = url.hostname.replace(/\.$/, '');
  return url.protocol === wildcard[1] + ':' && (host === domain || host.endsWith('.' + domain));
}

export function sourcePermissionOrigins(sources = []) {
  return [...new Set(sources
    .flatMap(source => [source?.baseUrl, source?.homeUrl])
    .map(value => permissionPattern(value))
    .filter(Boolean))].sort();
}

export function artifactPermissionOrigins(urls = []) {
  const origins = new Set(urls.map(value => permissionPattern(value)).filter(Boolean));
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com'
        && /^\/[^/]+\/[^/]+\/releases\/download\/.+/.test(url.pathname)) {
        origins.add('https://release-assets.githubusercontent.com/*');
        origins.add('https://objects.githubusercontent.com/*');
      }
    } catch { /* Invalid URLs are rejected by the repository parser. */ }
  }
  return [...origins].sort();
}

export async function missingPermissionOrigins(browser, origins) {
  if (!browser?.permissions?.contains) return [...origins];
  const missing = [];
  for (const origin of [...new Set(origins)].sort()) {
    if (!await browser.permissions.contains({ origins: [origin] })) missing.push(origin);
  }
  return missing;
}

export async function requestPermissionOrigins(browser, origins) {
  const requested = [...new Set(origins)].filter(Boolean).sort();
  if (requested.some(pattern => !safePermissionGrant(pattern))) throw new Error('Unsafe host permission pattern refused.');
  if (!requested.length) return true;
  if (!browser?.permissions?.request) throw new Error('Source-site permissions are available in the browser extension build. Open it from the extension toolbar.');
  return Boolean(await browser.permissions.request({ origins: requested }));
}
