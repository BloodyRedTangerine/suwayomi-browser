import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';

async function fixture() {
  const store = new MemoryStore();
  const calls = [];
  const control = { fail: false };
  const manager = {
    list: async () => [],
    sources: async () => [{ id: 'fixture', name: 'Fixture', lang: 'en', baseUrl: 'https://fixture.test' }],
    call: async (_source, operation, args) => {
      if (operation !== 'update') throw new Error('Unexpected source operation: ' + operation);
      calls.push({ fetchDetails: args.fetchDetails, fetchChapters: args.fetchChapters, mangaId: args.manga.id });
      if (control.fail) throw new Error('Fixture source unavailable');
      return {
        manga: args.fetchDetails ? { title: args.manga.title + ' refreshed', url: args.manga.url, author: 'Fixture author' } : args.manga,
        chapters: args.fetchChapters ? [{ url: args.manga.url + '/chapter-2', name: 'Chapter 2', number: 2, dateUpload: 2000 }] : [],
      };
    },
  };
  const api = new BrowserBackend(store, { manager, autoUpdates: false });
  await api.loading;
  return { api, store, manager, calls, control };
}

async function drain(api) {
  api.autoUpdates = true;
  api.kickUpdater();
  for (let count = 0; api.updaterTask && count < 20; count++) await api.updaterTask;
  assert.equal(api.updaterTask, null);
  assert.equal(api.updaterFailure, undefined);
}

test('Library update queues real source update calls and persists terminal status', async () => {
  const { api, store, calls } = await fixture();
  const { category } = await api.resolve('createCategory', { input: { name: 'Updates', includeInUpdate: 'INCLUDE' } });
  const manga = api.rememberManga('fixture', { url: '/series', title: 'Series' });
  Object.assign(manga, { inLibrary: true, categoryIds: [category.id] });
  await api.save();

  const started = await api.resolve('updateLibrary', { input: { categories: null, clientMutationId: 'refresh' } });
  assert.equal(started.clientMutationId, 'refresh');
  assert.equal(started.updateStatus.jobsInfo.isRunning, true);
  assert.equal(started.updateStatus.jobsInfo.totalJobs, 1);
  assert.equal(started.updateStatus.mangaUpdates[0].status, 'PENDING');
  assert.equal(started.updateStatus.categoryUpdates[0].status, 'UPDATING');

  await drain(api);
  const status = await api.resolve('libraryUpdateStatus');
  assert.equal(status.jobsInfo.isRunning, false);
  assert.equal(status.jobsInfo.finishedJobs, 1);
  assert.equal(status.mangaUpdates[0].status, 'COMPLETE');
  assert.equal(api.find('mangas', manga.id).initialized, true);
  assert.equal(api.find('mangas', manga.id).title, 'Series refreshed');
  assert.equal(api.db.chapters.filter(chapter => chapter.mangaId === manga.id).length, 1);
  assert.equal(api.db.chapters.find(chapter => chapter.mangaId === manga.id).url, '/series/chapter-2');
  assert.deepEqual(calls, [{ fetchDetails: true, fetchChapters: true, mangaId: manga.id }]);
  assert.equal((await store.get('settings', 'webui:database')).value.updater.lastUpdateTimestamp > 0, true);

  const subscription = await api.resolve('libraryUpdateStatusChanged', { input: {} });
  assert.equal(subscription.jobsInfo.finishedJobs, 1);
  assert.equal(subscription.mangaUpdates[0].manga().title, 'Series refreshed');
});

test('Library update applies category inclusion and manga skip settings', async () => {
  const { api, calls } = await fixture();
  const included = (await api.resolve('createCategory', { input: { name: 'Included', includeInUpdate: 'INCLUDE' } })).category.id;
  const excluded = (await api.resolve('createCategory', { input: { name: 'Excluded', includeInUpdate: 'EXCLUDE' } })).category.id;
  const first = api.rememberManga('fixture', { url: '/first', title: 'First' });
  const second = api.rememberManga('fixture', { url: '/second', title: 'Second', status: 'COMPLETED' });
  Object.assign(first, { inLibrary: true, categoryIds: [included] });
  Object.assign(second, { inLibrary: true, categoryIds: [included, excluded], initialized: true });
  await api.save();

  await api.resolve('setSettings', { input: { settings: { excludeCompleted: true, excludeNotStarted: false, updateMangas: false } } });
  const status = (await api.resolve('updateLibrary', { input: {} })).updateStatus;
  assert.equal(status.jobsInfo.totalJobs, 1);
  assert.equal(status.jobsInfo.skippedMangasCount, 1);
  assert.equal(status.mangaUpdates[0].manga().title, 'First');
  await drain(api);
  assert.deepEqual(calls.map(call => call.mangaId), [first.id]);

  await api.resolve('setSettings', { input: { settings: { excludeCompleted: false } } });
  const forced = (await api.resolve('updateLibrary', { input: { categories: [excluded] } })).updateStatus;
  assert.equal(forced.jobsInfo.totalJobs, 1);
  assert.equal(forced.mangaUpdates[0].manga().title, 'Second');
});

test('Failed library jobs remain visible and a new update explicitly retries them', async () => {
  const { api, control } = await fixture();
  const manga = api.rememberManga('fixture', { url: '/failed', title: 'Failed' });
  Object.assign(manga, { inLibrary: true });
  await api.save();
  control.fail = true;
  await api.resolve('updateLibrary', { input: {} });
  await drain(api);
  let status = await api.resolve('libraryUpdateStatus');
  assert.equal(status.mangaUpdates[0].status, 'FAILED');
  assert.match(api.db.updater.queue[0].error, /unavailable/);

  control.fail = false;
  await api.resolve('updateLibrary', { input: {} });
  await drain(api);
  status = await api.resolve('libraryUpdateStatus');
  assert.equal(status.mangaUpdates[0].status, 'COMPLETE');
});

test('A started updater resumes after reload and two tabs share one source runner', async () => {
  const { api, store, manager, calls } = await fixture();
  const manga = api.rememberManga('fixture', { url: '/cold', title: 'Cold' });
  Object.assign(manga, { inLibrary: true });
  await api.save();
  await api.resolve('updateLibrary', { input: {} });
  assert.equal((await store.get('settings', 'webui:database')).value.updater.queue[0].state, 'PENDING');
  api.dispose();
  const first = new BrowserBackend(store, { manager });
  const second = new BrowserBackend(store, { manager });
  await Promise.all([first.loading, second.loading]);
  await Promise.all([drain(first), drain(second)]);
  assert.equal(calls.length, 1);
  assert.equal((await first.resolve('libraryUpdateStatus')).mangaUpdates[0].status, 'COMPLETE');
  first.dispose(); second.dispose();
});

test('Automatic update interval runs only through an open app document and persists its timestamp', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {};
  try {
    const { api, calls } = await fixture();
    const manga = api.rememberManga('fixture', { url: '/scheduled', title: 'Scheduled' });
    Object.assign(manga, { inLibrary: true });
    await api.save();
    api.autoUpdates = true;
    await api.resolve('setSettings', { input: { settings: { globalUpdateInterval: 0.000001 } } });
    for (let count = 0; count < 100 && !calls.length; count++) await new Promise(resolve => setTimeout(resolve, 2));
    if (api.updaterTask) await api.updaterTask;
    assert.equal(calls.length, 1);
    assert.equal(api.db.updater.lastAutomatedUpdateTimestamp > 0, true);
    api.dispose();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('Updater settings persist locally and unsupported desktop settings fail explicitly', async () => {
  const { api, store, manager } = await fixture();
  await api.resolve('setSettings', { input: { settings: {
    updateMangas: true, excludeUnreadChapters: true, excludeNotStarted: true,
    excludeCompleted: true, autoDownloadNewChapters: true,
    excludeEntryWithUnreadChapters: false, autoDownloadNewChaptersLimit: 3,
    autoDownloadIgnoreReUploads: true, globalUpdateInterval: 6,
  } } });
  const restored = new BrowserBackend(store, { manager, autoUpdates: false });
  await restored.loading;
  const settings = await restored.resolve('settings');
  assert.deepEqual(
    Object.fromEntries(['updateMangas', 'excludeUnreadChapters', 'excludeNotStarted', 'excludeCompleted', 'autoDownloadNewChapters', 'excludeEntryWithUnreadChapters', 'autoDownloadNewChaptersLimit', 'autoDownloadIgnoreReUploads', 'globalUpdateInterval'].map(key => [key, settings[key]])),
    { updateMangas: true, excludeUnreadChapters: true, excludeNotStarted: true, excludeCompleted: true, autoDownloadNewChapters: true, excludeEntryWithUnreadChapters: false, autoDownloadNewChaptersLimit: 3, autoDownloadIgnoreReUploads: true, globalUpdateInterval: 6 },
  );
  await assert.rejects(api.resolve('setSettings', { input: { settings: { downloadsPath: '/desktop' } } }), /not implemented server setting downloadsPath/);
});
