import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend, createDefaultLibraryData, LIBRARY_MIGRATIONS, LIBRARY_SCHEMA_VERSION, migrateLibraryData } from '../src/webui/backend.mjs';

function legacyLibrary() {
  return {
    nextId: 50,
    mangas: [{ id: 12, sourceId: 'fixture', url: '/manga', title: 'Saved manga', inLibrary: true, categoryIds: [5] }],
    chapters: [{ id: 18, mangaId: 12, url: '/chapter', name: 'Saved chapter', isRead: true, lastPageRead: 6, isDownloaded: true, pages: [{ url: '/page', imageUrl: '/image' }] }],
    categories: [
      { id: 0, name: 'Default', order: 0, isDefaultCategory: true },
      { id: 5, name: 'Reading', order: 1, default: true },
    ],
    meta: [{ mangaId: 12, key: 'note', value: 'keep me' }],
    repositories: [{ url: 'https://repo.example/index.min.json', name: 'Example' }],
    sourceMeta: [{ sourceId: 'fixture', key: 'setting', value: 'preserved' }],
    settings: { excludeCompleted: false, userPreference: 'kept' },
    trackRecords: [{ id: 4, mangaId: 12, trackerId: 0, status: 2, startDate: '2026-10-18', finishDate: '0' }],
    downloads: { state: 'STARTED', queue: [{ chapterId: 18, state: 'DOWNLOADING', tries: 2, progress: 0.5, manifestReady: true }] },
    updater: { state: 'STARTED', queue: [{ mangaId: 12, state: 'PENDING', tries: 1 }], lastUpdateTimestamp: 123 },
  };
}

test('schema-1 0.2.62 library upgrades in place and preserves library, progress, queues and neighboring records', async () => {
  const store = new MemoryStore();
  const original = legacyLibrary();
  await store.put('settings', { key: 'webui:database', value: original });
  await store.put('settings', { key: 'webui:page:18:0', remoteUrl: JSON.stringify(['/page', '/image']), blob: new Blob(['cached page'], { type: 'image/jpeg' }) });
  await store.put('settings', { key: 'extension:fixture', packageName: 'fixture', jar: new Blob(['installed source']) });
  await store.put('settings', { key: 'jvm:preferences', value: '{"fixture":true}' });

  const backend = Object.create(BrowserBackend.prototype);
  backend.store = store;
  await backend.load();

  assert.equal(backend.db.schemaVersion, LIBRARY_SCHEMA_VERSION);
  assert.equal(backend.db.nextId, 50);
  assert.equal(backend.db.nextTrackId, 5);
  assert.deepEqual(backend.db.mangas, original.mangas);
  assert.deepEqual(backend.db.chapters, original.chapters);
  assert.deepEqual(backend.db.categories, original.categories);
  assert.deepEqual(backend.db.meta, original.meta);
  assert.deepEqual(backend.db.repositories, original.repositories);
  assert.deepEqual(backend.db.sourceMeta, original.sourceMeta);
  assert.deepEqual(backend.db.settings, original.settings);
  assert.deepEqual(backend.db.downloads, original.downloads);
  assert.deepEqual(backend.db.updater.queue, original.updater.queue);
  assert.equal(backend.db.updater.lastUpdateTimestamp, 123);
  assert.equal(backend.db.updater.lastAutomatedUpdateTimestamp, 0);
  assert.equal(backend.db.trackRecords[0].startDate, String(Date.parse('2026-10-18T00:00:00.000Z')));
  assert.equal(backend.db.trackRecords[0].finishDate, '0');

  const persisted = await store.get('settings', 'webui:database');
  assert.equal(persisted.value.schemaVersion, 2);
  assert.deepEqual(persisted.value.mangas, original.mangas);
  assert.deepEqual(persisted.value.chapters, original.chapters);
  assert.equal((await store.get('settings', 'webui:page:18:0')).blob.size, 11);
  assert.equal(await (await store.get('settings', 'extension:fixture')).jar.text(), 'installed source');
  assert.equal((await store.get('settings', 'jvm:preferences')).value, '{"fixture":true}');
});

test('schema-1 migration fills only absent defaults and derives a safe nextId', () => {
  const migrated = migrateLibraryData({ mangas: [{ id: 10 }], chapters: [], meta: [], repositories: [], sourceMeta: [], trackRecords: [] });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.nextId, 11);
  assert.equal(migrated.nextTrackId, 1);
  assert.deepEqual(migrated.categories, [{ id: 0, name: 'Default', default: false, order: 0, isDefaultCategory: true, includeInUpdate: 'UNSET', includeInDownload: 'UNSET' }]);
  assert.deepEqual(migrated.downloads, { state: 'STOPPED', queue: [] });
  assert.deepEqual(migrated.settings, {});
  assert.deepEqual(migrated.backupRestores, {});
  assert.deepEqual(migrated.updater.queue, []);
  assert.equal(createDefaultLibraryData().schemaVersion, LIBRARY_SCHEMA_VERSION);
  assert.deepEqual(LIBRARY_MIGRATIONS.map(({ from, to }) => [from, to]), [[1, 2]]);
});

test('future, gapped and malformed library data fails closed without overwriting the stored row', async () => {
  assert.throws(() => migrateLibraryData({ schemaVersion: 99 }), /newer than this build supports/);
  assert.throws(() => migrateLibraryData({ schemaVersion: 0 }), /Unsupported browser library schema/);

  const store = new MemoryStore();
  const corrupt = { mangas: [], chapters: [], categories: [], downloads: { queue: 'not an array' } };
  await store.put('settings', { key: 'webui:database', value: corrupt });
  const backend = Object.create(BrowserBackend.prototype);
  backend.store = store;
  await assert.rejects(backend.load(), /downloads.queue must be an array/);
  assert.deepEqual((await store.get('settings', 'webui:database')).value, corrupt);
});
