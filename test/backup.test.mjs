import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';

function manager() {
  return {
    list: async () => [],
    sources: async () => [{ id: 'source-a', name: 'Source A', lang: 'en', baseUrl: 'https://source-a.test' }],
    call: async () => { throw new Error('Backup test does not execute source operations'); },
  };
}

async function seeded() {
  const store = new MemoryStore();
  const api = new BrowserBackend(store, { manager: manager(), autoDownloads: false, autoUpdates: false });
  await api.loading;
  const category = (await api.resolve('createCategory', { input: { name: 'Saved', includeInDownload: 'INCLUDE' } })).category;
  const manga = api.rememberManga('source-a', { url: '/saved', title: 'Saved Manga', author: 'Author' });
  Object.assign(manga, { inLibrary: true, categoryIds: [category.id], initialized: true });
  await api.rememberChapters(manga, [{ url: '/saved/1', name: 'Chapter 1', number: 1, dateUpload: 1000 }]);
  await api.save();
  await api.resolve('setSettings', { input: { settings: { autoDownloadNewChapters: true, autoDownloadNewChaptersLimit: 2 } } });
  await api.save();
  return { api, store, manga };
}

test('Browser backup creates a local downloadable JSON and validates source presence', async () => {
  const { api } = await seeded();
  const created = await api.resolve('createBackup', { input: { flags: { includeServerSettings: true } } });
  assert.match(created.url, /^\/browser-local\/backup\//);
  const response = await api.fetch(created.url);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const backup = await response.json();
  assert.equal(backup.format, 'suwayomi-browser-backup');
  assert.equal(backup.flags.includeServerSettings, false);
  assert.equal(backup.mangas[0].title, 'Saved Manga');
  assert.equal(backup.chapters[0].name, 'Chapter 1');
  assert.equal(backup.settings.autoDownloadNewChapters, true);
  assert.deepEqual((await api.resolve('validateBackup', { input: { backup: new Blob([JSON.stringify(backup)], { type: 'application/json' }) } })).missingSources, []);
  api.dispose();
});

test('Browser backup restore replaces local library state, clears page/download caches and reports success', async () => {
  const { api, store } = await seeded();
  const created = await api.resolve('createBackup', { input: {} });
  const backup = await (await api.fetch(created.url)).blob();
  const oldManga = api.db.mangas[0];
  await api.resolve('updateManga', { input: { id: oldManga.id, patch: { inLibrary: false } } });
  api.db.mangas.push({ id: 999, sourceId: 'source-a', url: '/temporary', title: 'Temporary', inLibrary: true, categoryIds: [0] });
  api.db.chapters.push({ id: 1000, mangaId: 999, url: '/temporary/1', name: 'Temporary', number: 1, chapterNumber: 1, sourceOrder: 1, isDownloaded: true, pages: [] });
  await store.put('settings', { key: `webui:page:${oldManga.id}:0`, remoteUrl: 'stale', blob: new Blob(['stale']) });
  await api.save();

  const restored = await api.resolve('restoreBackup', { input: { backup } });
  assert.equal(restored.status.state, 'SUCCESS');
  assert.equal(restored.status.totalManga, 1);
  assert.equal(api.db.mangas.length, 1);
  assert.equal(api.db.mangas[0].title, 'Saved Manga');
  assert.equal(api.db.chapters.length, 1);
  assert.equal(api.db.chapters[0].isDownloaded, false);
  assert.equal(api.db.downloads.queue.length, 0);
  assert.equal(await store.get('settings', `webui:page:${oldManga.id}:0`), undefined);
  const status = await api.resolve('restoreStatus', { id: restored.id });
  assert.equal(status.state, 'SUCCESS');
  api.dispose();
});

test('Browser backup rejects desktop/binary formats and reports missing source identities', async () => {
  const { api } = await seeded();
  const missing = { format: 'suwayomi-browser-backup', version: 1, sources: [{ id: 'missing', name: 'Missing' }], categories: [], mangas: [], chapters: [] };
  const result = await api.resolve('validateBackup', { input: { backup: new Blob([JSON.stringify(missing)]) } });
  assert.deepEqual(result.missingSources, [{ __typename: 'ValidateBackupSource', id: 'missing', name: 'Missing' }]);
  await assert.rejects(api.resolve('validateBackup', { input: { backup: new Blob([JSON.stringify({ format: 'tachiyomi', version: 1 })]) } }), /Unsupported backup format/);
  api.dispose();
});
