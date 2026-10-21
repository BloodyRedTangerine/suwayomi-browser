// Runtime capabilities and extension identity; never infer these from a UA.
// DNR probe: Firefox 157 / Chrome 155 both support own-host scoped headers.
function extensionURL(api) {
  const url = new URL(api.runtime.getURL(''));
  if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol) || !url.host)
    throw new Error('A browser extension origin is required.');
  return url;
}

export function extensionOrigin(api) {
  const url = extensionURL(api);
  // Node's URL treats extension schemes as opaque, unlike the actual browsers.
  return `${url.protocol}//${url.host}`;
}

export const extensionHost = api => extensionURL(api).host;
export const dnrInitiatorDomains = api => [extensionHost(api)];

export function sandboxWebViewBootstrap(key, api = globalThis.chrome) {
  const path = 'src/extensions/webview-sandbox.html';
  if (!api?.runtime?.getManifest?.().sandbox?.pages?.includes(path)) return null;
  return api.runtime.getURL(path) + '#' + encodeURIComponent(key);
}

// Firefox match patterns cannot express a port; Chrome port scoping is retained.
// The origin scheme is the installed platform, not a user-agent guess.
export function hostPermissionOrigin(url, api = globalThis.chrome) {
  const firefox = typeof api?.runtime?.getURL === 'function'
    && new URL(api.runtime.getURL('')).protocol === 'moz-extension:';
  return `${url.protocol}//${firefox ? url.hostname : url.host}`;
}

export function isOwnBackgroundRequest(details, api) {
  if (details.tabId !== -1) return false;
  const from = details.initiator ?? details.originUrl ?? details.documentUrl;
  if (typeof from !== 'string') return false;
  try {
    const url = new URL(from);
    if (url.username || url.password) return false;
    return `${url.protocol}//${url.host}` === extensionOrigin(api);
  } catch { return false; }
}

export function headersReceivedExtraInfo(api) {
  const extra = api.webRequest?.OnHeadersReceivedOptions?.EXTRA_HEADERS;
  return extra ? ['responseHeaders', extra] : ['responseHeaders'];
}

export function observedResponseHeaders(headers = []) {
  // Firefox joins repeated Set-Cookie fields with LF in webRequest; Chromium
  // reports separate fields. Never split on comma (Expires contains commas).
  return headers.filter(header => typeof header.value === 'string').flatMap(header =>
    header.name.toLowerCase() === 'set-cookie'
      ? header.value.split(/\r?\n/).filter(Boolean).map(value => [header.name, value])
      : [[header.name, header.value]]);
}

export function responseObservationGraceMs(api) {
  // Measured Firefox ordering: opaque fetch can resolve before its matching
  // nonblocking onHeadersReceived callback. Keep Chromium's original path.
  return extensionOrigin(api).startsWith('moz-extension:') ? 1000 : 0;
}

export const supportsBlockingWebRequest = api =>
  api.runtime.getManifest().permissions?.includes('webRequestBlocking') === true;

export async function checkExactHeaderRegex(api, regex) {
  if (typeof api.declarativeNetRequest?.isRegexSupported !== 'function')
    throw new Error('Browser cannot verify exact source-header scoping.');
  const support = await api.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: true });
  if (!support.isSupported) throw new Error('Browser cannot safely scope source headers to this URL: ' + support.reason);
}
