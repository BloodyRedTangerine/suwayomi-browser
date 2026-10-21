import { browserFetch, browserFetchStream, encodeBytes } from './transport.mjs';
import { createObservedFetch, createObservedFetchStream } from './response-headers.mjs';
import { permissionPattern } from './permissions.mjs';
import { dnrInitiatorDomains, checkExactHeaderRegex, extensionOrigin } from './platform.mjs';

// Keep native WebView navigation header rules outside the source-fetch rule
// range; both APIs share Chromium's session ruleset.
export const WEBVIEW_NAVIGATION_RULE_BASE = 2_000_000_000;

// DNR urlFilter treats *, ^ and | specially. Escape a canonical URL as an
// exact, case-sensitive RE2 pattern instead; never broaden cookie rules.
// https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
export function exactRequestPattern(value) {
  const url = new URL(value);
  url.hash = '';
  return '^' + url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
}

export function createSourceBroker(
  browser,
  fetchRequest = createObservedFetch(browser, browserFetch),
  streamFetchRequest = createObservedFetchStream(browser, browserFetchStream),
) {
  let queue = Promise.resolve(), initialized = false, ruleId = 1000;
  const dirty = new Set();
  const active = new Map(), cancelled = new Set();
  const controlledHeaders = new Set(['referer', 'origin', 'user-agent', 'cookie', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
  async function clean() {
    if (!initialized) {
      // Session rules survive service-worker suspension/restart. This id range
      // is reserved for this broker; remove interrupted requests before use.
      const stale = (await browser.declarativeNetRequest.getSessionRules()).filter(rule => rule.id > 1000 && rule.id < WEBVIEW_NAVIGATION_RULE_BASE);
      for (const rule of stale) dirty.add(rule.id);
    }
    if (dirty.size) await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...dirty] });
    dirty.clear(); initialized = true;
  }
  async function prepareRequest(original, signal) {
    if (signal?.aborted) throw signal.reason;
    await clean(); // Fail closed if a prior header rule could not be removed.
    const url = new URL(original.url);
    url.hash = '';
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only source HTTP(S) requests are supported.');
    if (url.username || url.password) throw new Error('Embedded URL credentials are not supported by browser transport.');
    const origin = permissionPattern(url.href, browser);
    if (!origin || !await browser.permissions.contains({ origins: [origin] })) {
      const error = new Error('Enable source access in the extension before contacting ' + url.hostname);
      error.deniedOrigin = origin;
      throw error;
    }
    if (signal?.aborted) throw signal.reason;
    const request = { ...original, url: url.href };
    const controlled = (request.headers || []).filter(([name]) => controlledHeaders.has(name.toLowerCase()));
    let id;
    if (controlled.length) {
      if (ruleId + 1 >= WEBVIEW_NAVIGATION_RULE_BASE) throw new Error('Source request header rule identifiers are exhausted.');
      const regexFilter = exactRequestPattern(url.href);
      await checkExactHeaderRegex(browser, regexFilter);
      id = ++ruleId; dirty.add(id);
      try {
        await browser.declarativeNetRequest.updateSessionRules({ addRules: [{
          id, priority: 1,
          // Firefox rejects an empty DNR set value; suppress that header without
          // substituting a browser Referer/Origin/cookie. Chromium accepts and
          // sends literal empty values, so preserve its desktop-compatible wire
          // behavior. Both paths retain the same exact-URL scope.
          action: { type: 'modifyHeaders', requestHeaders: controlled.map(([header, value]) => value === '' && extensionOrigin(browser).startsWith('moz-extension:')
            ? { header, operation: 'remove' } : { header, operation: 'set', value }) },
          condition: { regexFilter, isUrlFilterCaseSensitive: true, initiatorDomains: dnrInitiatorDomains(browser), resourceTypes: ['xmlhttprequest'] },
        }], removeRuleIds: [] });
      } catch (error) {
        try { await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); dirty.delete(id); } catch {}
        throw error;
      }
    }
    return { request: { ...request, headers: (request.headers || []).filter(([name]) => !controlledHeaders.has(name.toLowerCase())) }, ruleId: id };
  }
  async function releaseRule(id) {
    if (!id) return;
    try { await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); dirty.delete(id); }
    catch (error) { console.warn('Source header rule cleanup failed; further requests require successful cleanup.', error.message); }
  }
  async function notifyPermission(error) {
    if (error?.deniedOrigin && browser.runtime.sendMessage)
      try { await browser.runtime.sendMessage({ type: 'suwayomi:permission-required', origin: error.deniedOrigin }); } catch {}
  }
  const enqueue = task => {
    queue = queue.catch(() => {}).then(task);
    return queue;
  };
  const handleMessage = (message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    if (message?.type === 'suwayomi:fetch-cancel') {
      const requestId = String(message.requestId || '');
      if (requestId) {
        const controller = active.get(requestId);
        if (controller) controller.abort(new DOMException('The source request was aborted.', 'AbortError'));
        else {
          if (cancelled.size >= 256) cancelled.delete(cancelled.values().next().value);
          cancelled.add(requestId);
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== 'suwayomi:fetch') return;
    const requestId = String(message.requestId || '');
    const controller = new AbortController();
    if (requestId) {
      if (cancelled.delete(requestId)) controller.abort(new DOMException('The source request was aborted.', 'AbortError'));
      active.set(requestId, controller);
    }
    enqueue(async () => {
      let id;
      try {
        const prepared = await prepareRequest(message.request, controller.signal);
        id = prepared.ruleId;
        if (controller.signal.aborted) throw controller.signal.reason;
        sendResponse(await fetchRequest(prepared.request, { signal: controller.signal }));
      } catch (error) {
        await notifyPermission(error);
        sendResponse({ error: error?.message || String(error), ...(error?.deniedOrigin ? { deniedOrigin: error.deniedOrigin } : {}) });
      }
      finally {
        await releaseRule(id);
        if (requestId && active.get(requestId) === controller) active.delete(requestId);
      }
    });
    return true;
  };
  handleMessage.connect = port => {
    if (port.name !== 'suwayomi:fetch-stream' || port.sender?.id !== browser.runtime.id) { try { port.disconnect(); } catch {} return; }
    const controller = new AbortController();
    let started = false, requestId = '';
    let acknowledgeChunk;
    const cancel = () => {
      if (!controller.signal.aborted) controller.abort(new DOMException('The streamed source request was cancelled.', 'AbortError'));
      acknowledgeChunk?.();
    };
    port.onDisconnect.addListener(cancel);
    port.onMessage.addListener(message => {
      if (message?.type === 'cancel') { if (!requestId || String(message.requestId || '') === requestId) cancel(); return; }
      if (message?.type === 'ack') { if (String(message.requestId || '') === requestId) acknowledgeChunk?.(); return; }
      if (message?.type !== 'fetch' || started) return;
      started = true; requestId = String(message.requestId || '');
      if (requestId) {
        if (cancelled.delete(requestId)) cancel();
        active.set(requestId, controller);
      }
      enqueue(async () => {
        let id, streaming = false;
        const post = value => { try { port.postMessage(value); return true; } catch { return false; } };
        const waitForChunkAcknowledgement = () => new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
          const finish = callback => {
            if (settled) return;
            settled = true; cleanup();
            if (acknowledgeChunk === acknowledge) acknowledgeChunk = undefined;
            callback();
          };
          const acknowledge = () => finish(resolve);
          const onAbort = () => finish(() => reject(controller.signal.reason || new DOMException('The streamed source request was cancelled.', 'AbortError')));
          acknowledgeChunk = acknowledge;
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          const prepared = await prepareRequest(message.request, controller.signal);
          id = prepared.ruleId;
          if (controller.signal.aborted) throw controller.signal.reason;
          const response = await streamFetchRequest(prepared.request, { signal: controller.signal });
          if (!response || !Number.isInteger(response.status)) throw new Error('Browser returned an invalid streamed source response.');
          if (!post({ type: 'headers', status: response.status, statusText: response.statusText || '', url: response.url || prepared.request.url, headers: response.headers || [] }))
            throw new Error('The source stream port closed before response headers were delivered.');
          const reader = response.body?.getReader?.();
          if (reader) {
            streaming = true;
            void (async () => {
              try {
                while (true) {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  const part = await reader.read();
                  if (part.done) break;
                  const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
                  for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    const chunk = bytes.subarray(offset, offset + 48 * 1024);
                    if (!chunk.length) continue;
                    const acknowledged = waitForChunkAcknowledgement();
                    if (!post({ type: 'chunk', body: encodeBytes(chunk) })) {
                      cancel(); await acknowledged; throw new Error('The source stream port closed before its chunk was delivered.');
                    }
                    await acknowledged;
                  }
                }
                post({ type: 'end' });
              } catch (error) {
                post({ type: 'error', message: error?.message || String(error) });
              } finally {
                if (requestId && active.get(requestId) === controller) active.delete(requestId);
              }
            })();
          } else post({ type: 'end' });
        } catch (error) {
          await notifyPermission(error);
          post({ type: 'error', message: error?.message || String(error), ...(error?.deniedOrigin ? { deniedOrigin: error.deniedOrigin } : {}) });
        } finally {
          await releaseRule(id);
          if (!streaming && requestId && active.get(requestId) === controller) active.delete(requestId);
        }
      });
    });
  };
  return handleMessage;
}
