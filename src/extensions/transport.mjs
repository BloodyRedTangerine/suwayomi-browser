export function encodeBytes(bytes) {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(value);
}
export function decodeBytes(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export async function browserFetch(request, { redirect = 'manual', signal } = {}) {
  const url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Source requests must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Embedded URL credentials are not supported by browser transport.');
  const headers = new Headers(request.headers || []);
  // The JVM exposes native body metadata to source network interceptors, but
  // buffered Fetch bytes must use browser-generated framing, never stale source
  // Content-Length/Transfer-Encoding values. These headers are forbidden in Fetch.
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new DOMException('The source request was aborted.', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('The source request timed out.', 'TimeoutError')), 120_000);
  try {
    const response = await fetch(url, {
      method: request.method || 'GET',
      // Do not lend arbitrary APK/JAR code the user's existing website sessions.
      // Source-provided Cookie headers are handled separately by the local broker.
      headers, credentials: 'omit', redirect, cache: 'no-store',
      body: ['GET', 'HEAD'].includes(request.method || 'GET') || !request.body ? undefined : decodeBytes(request.body),
      signal: controller.signal,
    });
    // An ordinary webpage cannot read a manual cross-origin redirect. The
    // installed extension's scoped observer reconstructs its metadata instead.
    if (response.type === 'opaqueredirect') return { status: 0, statusText: '', url: url.href, headers: [], body: '' };
    const responseHeaders = new Headers(response.headers);
    // Fetch has already decoded supported HTTP content encodings. Leaving the
    // wire headers intact makes source-side OkHttp compression interceptors
    // attempt to decompress those bytes a second time.
    const encodings = (responseHeaders.get('content-encoding') || '').split(',').map(value => value.trim().toLowerCase());
    if (encodings.length && encodings.every(value => ['gzip', 'x-gzip', 'deflate', 'br', 'zstd'].includes(value))) {
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
    }
    return { status: response.status, statusText: response.statusText, url: response.url, headers: [...responseHeaders], body: encodeBytes(new Uint8Array(await response.arrayBuffer())) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function browserFetchStream(request, { redirect = 'manual', signal } = {}) {
  const url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Source requests must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Embedded URL credentials are not supported by browser transport.');
  const headers = new Headers(request.headers || []);
  headers.delete('content-length'); headers.delete('transfer-encoding');
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal?.reason || new DOMException('The source request was aborted.', 'AbortError'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timer = setTimeout(() => abortController.abort(new DOMException('The source request timed out.', 'TimeoutError')), 120_000);
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    signal?.removeEventListener('abort', abort);
  };
  try {
    const response = await fetch(url, {
      method: request.method || 'GET', headers, credentials: 'omit', redirect, cache: 'no-store',
      body: ['GET', 'HEAD'].includes(request.method || 'GET') || !request.body ? undefined : decodeBytes(request.body),
      signal: abortController.signal,
    });
    if (response.type === 'opaqueredirect') {
      cleanup();
      return { status: 0, statusText: '', url: url.href, headers: [], body: null };
    }
    const responseHeaders = new Headers(response.headers);
    const encodings = (responseHeaders.get('content-encoding') || '').split(',').map(value => value.trim().toLowerCase());
    if (encodings.length && encodings.every(value => ['gzip', 'x-gzip', 'deflate', 'br', 'zstd'].includes(value))) {
      responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
    }
    if (!response.body) { cleanup(); return { status: response.status, statusText: response.statusText, url: response.url, headers: [...responseHeaders], body: null }; }
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) { cleanup(); controller.close(); }
          else controller.enqueue(part.value);
        } catch (error) { cleanup(); controller.error(error); }
      },
      async cancel(reason) {
        abortController.abort(reason || new DOMException('The response stream was cancelled.', 'AbortError'));
        try { await reader.cancel(reason); } finally { cleanup(); }
      },
    });
    return { status: response.status, statusText: response.statusText, url: response.url, headers: [...responseHeaders], body };
  } catch (error) { cleanup(); throw error; }
}

// In the extension, requests are brokered by its own local background worker.
export async function sourceFetchHop(request, { signal } = {}) {
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new DOMException('The source request was aborted.', 'AbortError');
  if (signal?.aborted) throw abortError();
  if (globalThis.chrome?.runtime?.id) {
    const requestId = globalThis.crypto?.randomUUID?.() || `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cancel = () => {
      try { Promise.resolve(chrome.runtime.sendMessage({ type: 'suwayomi:fetch-cancel', requestId })).catch(() => {}); } catch {}
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'suwayomi:fetch', requestId, request });
      if (signal?.aborted) throw abortError();
      if (!response) throw new Error('The local network worker did not respond.');
      if (response.error) throw Object.assign(new Error(response.error), { deniedOrigin: response.deniedOrigin });
      return response;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  const response = await browserFetch(request, { signal });
  if (!response.status) throw new Error('This source redirect requires the installed browser extension; a webpage cannot expose its response headers.');
  return response;
}

export async function sourceFetchStreamHop(request, { signal } = {}) {
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new DOMException('The source request was aborted.', 'AbortError');
  if (signal?.aborted) throw abortError();
  if (!globalThis.chrome?.runtime?.connect || !globalThis.chrome?.runtime?.id)
    return browserFetchStream(request, { signal });
  const port = chrome.runtime.connect({ name: 'suwayomi:fetch-stream' });
  const requestId = globalThis.crypto?.randomUUID?.() || `source-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    let headersReceived = false, finished = false, bodyController, waitingRead = false, pendingChunk = null;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const disconnect = () => { try { port.disconnect(); } catch {} };
    const fail = error => {
      if (finished) return;
      finished = true; cleanup();
      if (headersReceived) { try { bodyController?.error(error); } catch {} }
      else reject(error);
      disconnect();
    };
    const onAbort = () => {
      try { port.postMessage({ type: 'cancel', requestId }); } catch {}
      fail(abortError());
    };
    const body = new ReadableStream({
      start(controller) { bodyController = controller; },
      pull(controller) {
        if (pendingChunk) {
          const chunk = pendingChunk; pendingChunk = null;
          controller.enqueue(chunk);
          try { port.postMessage({ type: 'ack', requestId }); } catch (error) { fail(error); }
        } else waitingRead = true;
      },
      cancel(reason) {
        if (finished) return;
        try { port.postMessage({ type: 'cancel', requestId }); } catch {}
        finished = true; cleanup(); disconnect();
      },
    }, { highWaterMark: 0 });
    port.onMessage.addListener(message => {
      if (!message || finished) return;
      if (message.type === 'headers') {
        if (headersReceived) return fail(new Error('Duplicate streamed source response headers.'));
        headersReceived = true;
        resolve({ status: message.status, statusText: message.statusText || '', url: message.url || request.url, headers: message.headers || [], body });
      } else if (message.type === 'chunk') {
        if (!headersReceived) return fail(new Error('Source response chunk arrived before headers.'));
        if (pendingChunk) return fail(new Error('Source stream exceeded its one-chunk flow-control window.'));
        try {
          const chunk = decodeBytes(message.body || '');
          if (waitingRead) {
            waitingRead = false;
            bodyController.enqueue(chunk);
            port.postMessage({ type: 'ack', requestId });
          } else pendingChunk = chunk;
        } catch (error) { fail(error); }
      } else if (message.type === 'end') {
        if (!headersReceived) return fail(new Error('Source response ended before headers.'));
        finished = true; cleanup();
        try { bodyController.close(); } catch {}
        disconnect();
      } else if (message.type === 'error') fail(Object.assign(new Error(String(message.message || 'Streamed source request failed.')), { deniedOrigin: message.deniedOrigin }));
    });
    port.onDisconnect.addListener(() => {
      if (!finished) fail(new Error(chrome.runtime.lastError?.message || 'The source streaming port closed unexpectedly.'));
    });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { port.postMessage({ type: 'fetch', requestId, request }); }
    catch (error) { fail(error); }
  });
}

// Repository downloads and raw cached-image fallbacks have no JVM follow-up
// chain. Follow their redirects explicitly too; every hop still visits the
// permission broker. Do not give the JVM this wrapper or it would lose headers.
export async function fetchWithRedirects(request, transport = sourceFetchHop) {
  let current = { ...request, method: request.method || 'GET' };
  for (let count = 0; ; count++) {
    const response = await transport(current);
    if (![300, 301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.find(([name]) => name.toLowerCase() === 'location')?.[1];
    if (!location) return response;
    let target;
    try { target = new URL(location, current.url); } catch { return response; }
    if (!['http:', 'https:'].includes(target.protocol)) return response;
    if (target.username || target.password) throw new Error('Embedded URL credentials are not supported by browser transport.');
    target.hash = '';
    if (count === 20) throw new Error('Too many source redirect requests: 21');
    const original = new URL(current.url);
    const remove = new Set();
    let method = current.method, body = current.body;
    if (!['GET', 'HEAD', 'PROPFIND'].includes(method) && ![307, 308].includes(response.status) && (response.status === 303 || method !== 'QUERY')) {
      method = 'GET'; body = undefined;
      for (const name of ['transfer-encoding', 'content-length', 'content-type']) remove.add(name);
    }
    if (original.origin !== target.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) remove.add(name);
    current = { ...current, url: target.href, method, body, headers: (current.headers || []).filter(([name]) => !remove.has(name.toLowerCase())) };
  }
}

export function sourceFetch(request) { return fetchWithRedirects(request); }
