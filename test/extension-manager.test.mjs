import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { ExtensionManager } from '../src/extensions/manager.mjs';

test('Manager restores preferences before loading sources and serializes concurrent calls', async () => {
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.snapshot = '{}'; this.events = []; workers.push(this); }
    postMessage(command) {
      this.events.push(command.operation);
      let result;
      if (command.operation === 'preferences') {
        this.snapshot = command.args.restore ?? this.snapshot;
        result = this.snapshot;
      } else if (command.operation === 'state') {
        this.snapshot = command.args.restore?.value ?? this.snapshot;
        result = { preferences: this.snapshot, files: { version: 1, entries: [], fingerprint: '[]' } };
      } else if (command.operation === 'install') result = { sources: [{ id: 'source', isConfigurable: true }], jar: new Uint8Array() };
      else if (command.operation === 'call') { this.snapshot = '{"source":{"setting":{"t":"String","v":"saved"}}}'; result = 'ok'; }
      queueMicrotask(() => this.onmessage({ data: { id: command.id, result } }));
    }
    terminate() { this.terminated = true; }
  };
  try {
    const store = new MemoryStore();
    await store.put('settings', { key: 'extension:test', packageName: 'test', contentWarning: 'SAFE', sources: [], classes: [], jar: new Blob(['jar']) });
    await store.put('settings', { key: 'jvm:preferences', value: '{"initial":{}}' });
    const manager = new ExtensionManager(store);
    await Promise.all([manager.call('source', 'popular'), manager.call('source', 'search')]);
    assert.deepEqual(workers[0].events, ['state', 'install', 'call', 'state', 'call', 'state']);
    assert.ok((await store.get('settings', 'jvm:preferences')).value.includes('saved'));
    assert.equal((await manager.sources())[0].isConfigurable, true, 'Legacy source metadata should be refreshed on load');
    await manager.restart();
    await manager.call('source', 'popular');
    assert.deepEqual(workers[1].events.slice(0, 2), ['state', 'install']);
    assert.ok(workers[1].snapshot.includes('saved'));
    await manager.uninstall('test');
    assert.equal(workers[1].terminated, true);
    assert.equal((await manager.list()).length, 0);
    assert.ok((await store.get('settings', 'jvm:preferences')).value.includes('saved'));
    // This mock accepts calls without a source registry. It can still prove
    // that the deleted archive was not installed into the replacement worker.
    await manager.call('source', 'popular');
    assert.equal(workers[2].events.includes('install'), false);
    manager.runtime.dispose();
  } finally { globalThis.Worker = original; }
});

test('File-only checkpoints invalidate peer VMs, restore before constructors and commit atomically with preferences', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { this.preferences = '{}'; this.files = { version: 1, entries: [], fingerprint: '[]' }; this.constructorFiles = null; }
    postMessage({ id, operation, args }) {
      let result;
      if (operation === 'state') {
        if (args.restore) { this.preferences = args.restore.value; this.files = structuredClone(args.restore.files || this.files); }
        result = { preferences: this.preferences, files: structuredClone(this.files) };
      }
      if (operation === 'install') { this.constructorFiles = this.files.fingerprint; result = { sources: [{ id: 'source' }], jar: new Uint8Array() }; }
      if (operation === 'call') {
        if (args.operation === 'write') this.files = { version: 1, entries: [{ path: '/data/state', type: 'file', mode: 0o600, mtime: 1, bytes: new Uint8Array([args.byte]) }], fingerprint: String(args.byte) };
        result = this.files.fingerprint;
      }
      queueMicrotask(() => this.onmessage({ data: { id, result } }));
    }
    terminate() { this.terminated = true; }
  };
  let a, b;
  try {
    const store = new MemoryStore();
    await store.put('settings', { key: 'extension:fixture', packageName: 'fixture', contentWarning: 'SAFE', sources: [{ id: 'source' }], classes: ['Fixture'], jar: new Blob(['jar']) });
    a = new ExtensionManager(store); b = new ExtensionManager(store);
    await a.call('source', 'write', { byte: 7 });
    assert.equal(await b.call('source', 'read'), '7');
    assert.equal(b.runtime.worker.constructorFiles, '7');
    const previousVM = a.runtime.worker;
    await b.call('source', 'write', { byte: 9 });
    assert.equal(await a.call('source', 'read'), '9');
    assert.equal(previousVM.terminated, true); assert.equal(a.runtime.worker.constructorFiles, '9');
    const saved = await store.get('settings', 'jvm:preferences');
    assert.equal(saved.value, '{}'); assert.deepEqual(saved.files.entries[0].bytes, new Uint8Array([9]));
    const put = store.put.bind(store);
    store.put = async (name, value) => { if (value.key === 'jvm:preferences') throw new Error('quota exceeded'); return put(name, value); };
    await assert.rejects(a.call('source', 'write', { byte: 11 }), /quota exceeded/);
    assert.deepEqual(await store.get('settings', 'jvm:preferences'), saved);
  } finally { a?.runtime.dispose(); b?.runtime.dispose(); globalThis.Worker = original; }
});
