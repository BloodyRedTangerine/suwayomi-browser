import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';
import { ExtensionManager } from '../src/extensions/manager.mjs';

test('Store reads are snapshots, not shared references that hide lost-update races', async () => {
  const store = new MemoryStore();
  await store.put('settings', { key: 'test', value: { counter: 1 } });
  (await store.get('settings', 'test')).value.counter = 99;
  (await store.getAll('settings'))[0].value.counter = 42;
  assert.equal((await store.get('settings', 'test')).value.counter, 1);
});

test('Independent backends retain concurrent writes and reread changes from another tab', async () => {
  const store = new MemoryStore(), manager = { list: async () => [] };
  const a = new BrowserBackend(store, { manager }), b = new BrowserBackend(store, { manager });
  await Promise.all([a.loading, b.loading]);
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).resolve('setGlobalMetas', { input: { metas: [{ key: 'tab-race-' + i, value: String(i) }] } })));
  assert.equal((await a.resolve('metas')).totalCount, 30);
  assert.equal((await b.resolve('metas')).totalCount, 30);
  await a.resolve('deleteGlobalMetas', { input: { keys: ['tab-race-0'] } });
  assert.equal((await b.resolve('metas')).totalCount, 29);
  await assert.rejects(a.resolve('setGlobalMetas', { input: { metas: [{ key: 'invalid', value: 1 }] } }), /strings|string/);
  await b.resolve('setGlobalMetas', { input: { metas: [{ key: 'after-error', value: 'saved' }] } });
  assert.equal((await a.resolve('meta', { key: 'after-error' })).value, 'saved');
});

test('Separate managers merge persisted preferences and invalidate stale/uninstalled source VMs', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { this.snapshot = '{}'; this.installed = false; }
    postMessage({ id, operation, args }) {
      let result, error;
      if (operation === 'preferences') result = this.snapshot = args.restore ?? this.snapshot;
      if (operation === 'state') {
        this.snapshot = args.restore?.value ?? this.snapshot;
        result = { preferences: this.snapshot, files: { version: 1, entries: [], fingerprint: '[]' } };
      }
      if (operation === 'install') { this.installed = true; result = { sources: [{ id: 'source', lang: 'en' }], jar: new Uint8Array() }; }
      if (operation === 'call') {
        if (!this.installed) error = 'Source not installed';
        else {
          const values = JSON.parse(this.snapshot);
          if (args.operation === 'write') values[args.key] = args.value;
          result = this.snapshot = JSON.stringify(values);
        }
      }
      queueMicrotask(() => this.onmessage({ data: { id, result, error } }));
    }
    terminate() { this.terminated = true; }
  };
  let a, b;
  try {
    const store = new MemoryStore();
    await store.put('settings', { key: 'extension:test', packageName: 'test', contentWarning: 'SAFE', revision: 'initial', sources: [{ id: 'source' }], classes: [], jar: new Blob(['jar']) });
    a = new ExtensionManager(store); b = new ExtensionManager(store);
    await Promise.all([a.call('source', 'write', { key: 'left', value: 1 }), b.call('source', 'write', { key: 'right', value: 2 })]);
    assert.deepEqual(JSON.parse((await store.get('settings', 'jvm:preferences')).value), { left: 1, right: 2 });
    const stale = a.runtime.worker;
    assert.deepEqual(JSON.parse(await a.call('source', 'read')), { left: 1, right: 2 });
    assert.equal(stale.terminated, true);
    const beforeUpgrade = a.runtime.worker;
    await store.exclusive('runtime', async () => { const record = await store.get('settings', 'extension:test'); record.revision = 'replacement'; await store.put('settings', record); });
    await a.call('source', 'read'); assert.equal(beforeUpgrade.terminated, true);
    await b.uninstall('test');
    await assert.rejects(a.call('source', 'read'), /Source not installed/);
    assert.deepEqual(JSON.parse((await store.get('settings', 'jvm:preferences')).value), { left: 1, right: 2 });
    assert.equal((await a.list()).length, 0);
  } finally { a?.runtime.dispose(); b?.runtime.dispose(); globalThis.Worker = original; }
});
