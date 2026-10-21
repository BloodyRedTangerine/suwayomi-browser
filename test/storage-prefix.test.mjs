import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { ExtensionManager } from '../src/extensions/manager.mjs';

test('settings prefix reads, key scans and Blob summaries exclude unrelated settings', async () => {
  const store = new MemoryStore();
  await store.put('settings', { key: 'webui:page:12:0', blob: new Blob(['123']) });
  await store.put('settings', { key: 'webui:page:12:1', blob: new Blob(['4567']) });
  await store.put('settings', { key: 'webui:page:120:0', blob: new Blob(['not selected']) });
  await store.put('settings', { key: 'extension:fixture', packageName: 'fixture', contentWarning: 'SAFE', sources: [], classes: [], jar: new Blob(['code']) });
  await store.put('settings', { key: 'webui:database', value: {} });
  await store.put('settings', { key: 'webui:backup:test', blob: new Blob(['backup']) });

  const records = await store.getAllByPrefix('settings', 'webui:page:12:');
  assert.deepEqual(records.map(record => record.key), ['webui:page:12:0', 'webui:page:12:1']);
  assert.deepEqual(await store.getKeysByPrefix('settings', 'webui:page:12:'), ['webui:page:12:0', 'webui:page:12:1']);
  assert.deepEqual(await store.getPrefixStats('settings', 'webui:page:'), { count: 3, blobBytes: 19 });
  await assert.rejects(store.getAllByPrefix('pages', 'webui:page:'), /settings store/);
  await assert.rejects(store.getKeysByPrefix('settings', 12), /string settings-key prefix/);
});

test('ExtensionManager state/list avoid scanning page and backup records in settings', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  const store = new MemoryStore();
  await store.put('settings', { key: 'jvm:preferences', value: '{"fixture":true}', files: { fingerprint: 'state' } });
  await store.put('settings', { key: 'extension:fixture', packageName: 'fixture', contentWarning: 'SAFE', revision: 'one', sources: [], classes: [], jar: new Blob(['code']) });
  await store.put('settings', { key: 'webui:page:10:0', blob: new Blob(['image']) });
  await store.put('settings', { key: 'webui:backup:one', blob: new Blob(['backup']) });
  const manager = new ExtensionManager(store);
  manager.runtime.dispose();
  manager.runtime = { closed: false, dispose() {} };
  store.getAll = async () => { throw new Error('whole-settings scan was used'); };
  try {
    const state = JSON.parse(await manager.state());
    assert.deepEqual(state[0], '{"fixture":true}');
    assert.deepEqual(state[2], [['fixture', 'one', '', 4, 0, '', '']]);
    assert.deepEqual((await manager.list()).map(record => record.packageName), ['fixture']);
  } finally {
    manager.runtime.dispose();
    globalThis.Worker = previousWorker;
  }
});
