import { browserFetch, browserFetchStream } from './transport.mjs';
import { isOwnBackgroundRequest, headersReceivedExtraInfo, hostPermissionOrigin, observedResponseHeaders, responseObservationGraceMs } from './platform.mjs';

function waitForObservation(observation, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(signal.reason || new DOMException('The source request was aborted.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(), milliseconds);
    observation.then(() => finish());
  });
}

// Fetch deliberately hides Set-Cookie and manual redirect headers. Observe only
// this service worker's matching request, never a tab's ambient login traffic.
// https://developer.chrome.com/docs/extensions/reference/api/webRequest
export function createObservedFetch(browser, fetchRequest = browserFetch) {
  let cleanupFailure;
  return async (request, { signal } = {}) => {
    if (cleanupFailure) throw new Error('Response observer cleanup failed; reload the extension before further source requests.');
    const api = browser.webRequest;
    if (!api?.onBeforeRequest || !api?.onHeadersReceived) throw new Error('Source response-header observation is unavailable. Reload the updated extension.');
    const url = new URL(request.url);
    url.hash = '';
    let active = true, requestId, observed, ambiguous = false, beforeRequestSeen = false;
    let notifyObservation;
    const observation = new Promise(resolve => { notifyObservation = resolve; });
    const attached = [];
    const matches = details => active && details.url === url.href && details.method === (request.method || 'GET') && isOwnBackgroundRequest(details, browser) && details.type === 'xmlhttprequest';
    const before = details => {
      if (!matches(details)) return;
      beforeRequestSeen = true;
      if (requestId !== undefined && requestId !== details.requestId) { ambiguous = true; return; }
      requestId = details.requestId;
    };
    const received = details => {
      if (!matches(details)) return;
      // Chromium has contexts where the response event is exposed but the
      // matching onBeforeRequest event is not. A unique exact response event
      // still identifies this extension-worker request; conflicting IDs fail
      // closed rather than importing cookies from another request.
      if (requestId !== undefined && requestId !== details.requestId) {
        if (!beforeRequestSeen) ambiguous = true;
        return;
      }
      requestId = details.requestId;
      if (!Number.isInteger(details.statusCode) || details.statusCode < 200 || details.statusCode > 599) return;
      observed = {
        status: details.statusCode,
        statusText: (details.statusLine || '').replace(/^HTTP\/\S+\s+\d+\s*/, ''),
        headers: observedResponseHeaders(details.responseHeaders),
      };
      notifyObservation();
    };
    const filter = { urls: [hostPermissionOrigin(url, browser) + '/*'], types: ['xmlhttprequest'] };
    try {
      api.onBeforeRequest.addListener(before, filter); attached.push([api.onBeforeRequest, before]);
      api.onHeadersReceived.addListener(received, filter, headersReceivedExtraInfo(browser)); attached.push([api.onHeadersReceived, received]);
      // Each redirect must return to the JVM. Its next hop gets a fresh host
      // permission check, header rule and cookie match; Fetch may not auto-follow.
      const options = { redirect: 'manual' };
      if (signal) options.signal = signal;
      const response = await fetchRequest({ ...request, url: url.href }, options);
      const grace = responseObservationGraceMs(browser);
      if (!observed && !ambiguous && grace) await waitForObservation(observation, grace, signal);
      if (ambiguous) throw new Error('Ambiguous source response; no cookies were imported.');
      if (!observed || requestId === undefined) throw new Error('The browser did not expose this source response; refusing incomplete cookie/redirect handling.');
      const redirect = [300, 301, 302, 303, 307, 308].includes(observed.status);
      if (response.status === 0) {
        if (!redirect) throw new Error('Opaque source response was not an observed HTTP redirect.');
        // A manual redirect is opaqueredirect in Fetch: only the matching
        // webRequest event can supply its actual HTTP metadata. No body is exposed.
        const headers = observed.headers.filter(([name]) => !['content-encoding', 'content-length'].includes(name.toLowerCase()));
        return { status: observed.status, statusText: observed.statusText, url: url.href, headers, body: '' };
      }
      if (response.status !== observed.status || (response.url && response.url !== url.href)) throw new Error('Source response did not match its observed HTTP request.');
      const headers = (response.headers || []).filter(([name]) => name.toLowerCase() !== 'set-cookie');
      headers.push(...observed.headers.filter(([name]) => name.toLowerCase() === 'set-cookie'));
      return { ...response, url: url.href, headers };
    } finally {
      active = false; observed = undefined;
      for (const [event, listener] of attached.reverse()) {
        try { event.removeListener(listener); }
        catch { cleanupFailure = true; }
      }
      if (cleanupFailure) throw new Error('Response observer cleanup failed; reload the extension before further source requests.');
    }
  };
}

export function createObservedFetchStream(browser, fetchRequest = browserFetchStream) {
  let cleanupFailure;
  return async (request, { signal } = {}) => {
    if (cleanupFailure) throw new Error('Response observer cleanup failed; reload the extension before further source requests.');
    const api = browser.webRequest;
    if (!api?.onBeforeRequest || !api?.onHeadersReceived) throw new Error('Source response-header observation is unavailable. Reload the updated extension.');
    const url = new URL(request.url);
    url.hash = '';
    let active = true, requestId, observed, ambiguous = false, beforeRequestSeen = false;
    let notifyObservation;
    const observation = new Promise(resolve => { notifyObservation = resolve; });
    const attached = [];
    const matches = details => active && details.url === url.href && details.method === (request.method || 'GET') && isOwnBackgroundRequest(details, browser) && details.type === 'xmlhttprequest';
    const before = details => {
      if (!matches(details)) return;
      beforeRequestSeen = true;
      if (requestId !== undefined && requestId !== details.requestId) { ambiguous = true; return; }
      requestId = details.requestId;
    };
    const received = details => {
      if (!matches(details)) return;
      if (requestId !== undefined && requestId !== details.requestId) {
        if (!beforeRequestSeen) ambiguous = true;
        return;
      }
      requestId = details.requestId;
      if (!Number.isInteger(details.statusCode) || details.statusCode < 200 || details.statusCode > 599) return;
      observed = {
        status: details.statusCode,
        statusText: (details.statusLine || '').replace(/^HTTP\/\S+\s+\d+\s*/, ''),
        headers: observedResponseHeaders(details.responseHeaders),
      };
      notifyObservation();
    };
    const filter = { urls: [hostPermissionOrigin(url, browser) + '/*'], types: ['xmlhttprequest'] };
    try {
      api.onBeforeRequest.addListener(before, filter); attached.push([api.onBeforeRequest, before]);
      api.onHeadersReceived.addListener(received, filter, headersReceivedExtraInfo(browser)); attached.push([api.onHeadersReceived, received]);
      const options = { redirect: 'manual' };
      if (signal) options.signal = signal;
      const response = await fetchRequest({ ...request, url: url.href }, options);
      const grace = responseObservationGraceMs(browser);
      if (!observed && !ambiguous && grace) await waitForObservation(observation, grace, signal);
      if (ambiguous) throw new Error('Ambiguous source response; no cookies were imported.');
      if (!observed || requestId === undefined) throw new Error('The browser did not expose this source response; refusing incomplete cookie/redirect handling.');
      const redirect = [300, 301, 302, 303, 307, 308].includes(observed.status);
      if (response.status === 0) {
        if (!redirect) throw new Error('Opaque source response was not an observed HTTP redirect.');
        const headers = observed.headers.filter(([name]) => !['content-encoding', 'content-length'].includes(name.toLowerCase()));
        return { status: observed.status, statusText: observed.statusText, url: url.href, headers, body: null };
      }
      if (response.status !== observed.status || (response.url && response.url !== url.href)) throw new Error('Source response did not match its observed HTTP request.');
      const headers = (response.headers || []).filter(([name]) => name.toLowerCase() !== 'set-cookie');
      headers.push(...observed.headers.filter(([name]) => name.toLowerCase() === 'set-cookie'));
      return { ...response, url: url.href, headers };
    } finally {
      active = false; observed = undefined;
      for (const [event, listener] of attached.reverse()) {
        try { event.removeListener(listener); }
        catch { cleanupFailure = true; }
      }
      if (cleanupFailure) throw new Error('Response observer cleanup failed; reload the extension before further source requests.');
    }
  };
}
