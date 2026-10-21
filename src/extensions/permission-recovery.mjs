import { permissionPattern, permissionGrantPattern, permissionCovers } from './permissions.mjs';

// Only explicit pending operations opt into replay. Other source actions stay manual.
export function createPermissionRecovery(browser, { batchWindowMs = 2000 } = {}) {
  const requests = new Map(), listeners = new Set(), grantedListeners = new Set();
  let timer, ready = false, notification = null;
  const publish = () => { for (const listener of listeners) listener(); };
  function snapshot() {
    if (!requests.size) return notification ? [notification] : [];
    const origins = [...new Set([...requests.values()].map(item => item.pattern))].sort();
    return [{ id: 'permission-batch', origin: origins[0], origins,
      deniedOrigins: [...requests.keys()], ready, granted: false, error: '',
      operations: [...new Set([...requests.values()].flatMap(item => [...item.waiters.keys()]))],
      ...batchError }];
  }
  let batchError = {};
  function requireOrigin(value) {
    const origin = permissionPattern(value);
    if (!origin || origin !== value) return null;
    if (!requests.has(origin)) {
      requests.set(origin, { origin, pattern: permissionGrantPattern(origin), waiters: new Map() });
      notification = null; batchError = {};
      if (!timer && !ready) {
        timer = setTimeout(() => { timer = null; ready = true; publish(); }, batchWindowMs);
        timer.unref?.();
      }
    }
    return requests.get(origin);
  }
  function deniedOrigins(error) {
    return [...new Set([...(error?.deniedOrigins || []), error?.deniedOrigin].filter(origin => permissionPattern(origin) === origin))];
  }
  function noteDeniedOrigins(origins) {
    for (const origin of origins) requireOrigin(origin);
    publish();
  }
  const onMessage = message => {
    if (message?.type === 'suwayomi:permission-required') noteDeniedOrigins([message.origin]);
  };
  browser?.runtime?.onMessage?.addListener(onMessage);
  const api = {
    snapshot, noteDeniedOrigins,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeGranted(listener) { grantedListeners.add(listener); return () => grantedListeners.delete(listener); },
    async run(key, operation, { signal } = {}) {
      const abort = () => api.cancel(key);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          if (signal?.aborted) throw signal.reason || new DOMException('Operation cancelled.', 'AbortError');
          try { return await operation(); }
          catch (error) {
            const origins = deniedOrigins(error);
            if (!origins.length || signal?.aborted) throw error;
            await Promise.all(origins.map(origin => new Promise((resolve, reject) => {
              const request = requireOrigin(origin);
              const existing = request.waiters.get(key);
              if (existing) existing.reject(new Error('Permission operation was replaced.'));
              request.waiters.set(key, { resolve, reject });
              publish();
            })));
          }
        }
      } finally { signal?.removeEventListener('abort', abort); }
    },
    granted(patterns, allowed) {
      patterns = Array.isArray(patterns) ? patterns : [patterns];
      if (!allowed) { batchError = { error: 'Access was not granted. Use Allow to try again.' }; publish(); return; }
      const waiters = [];
      for (const [origin, request] of requests) {
        if (!patterns.some(pattern => permissionCovers(pattern, origin))) continue;
        waiters.push(...request.waiters.values()); requests.delete(origin);
      }
      if (!requests.size) {
        clearTimeout(timer); timer = null; ready = false;
        notification = waiters.length ? null : { id: 'permission-batch', origin: patterns[0], origins: patterns,
          operations: [], deniedOrigins: [], granted: true, ready: true, error: '' };
      }
      batchError = {}; publish();
      for (const waiter of waiters) waiter.resolve();
      return Promise.all([...grantedListeners].map(listener => listener(patterns)));
    },
    error(_origin, error) { batchError = { error: error?.message || 'Permission request failed.' }; publish(); },
    dismiss() { notification = null; publish(); },
    cancel(key) {
      for (const [origin, request] of requests) {
        const waiter = request.waiters.get(key);
        if (waiter) {
          request.waiters.delete(key); waiter.reject(new DOMException('Operation cancelled.', 'AbortError'));
          if (!request.waiters.size) requests.delete(origin);
        }
      }
      if (!requests.size) { clearTimeout(timer); timer = null; ready = false; }
      publish();
    },
    dispose() {
      clearTimeout(timer);
      for (const request of requests.values()) for (const waiter of request.waiters.values())
        waiter.reject(new DOMException('Permission recovery disposed.', 'AbortError'));
      requests.clear(); browser?.runtime?.onMessage?.removeListener(onMessage);
      listeners.clear(); grantedListeners.clear();
    },
  };
  return api;
}

let singleton;
export function getPermissionRecovery() { return singleton ||= createPermissionRecovery(globalThis.chrome); }
