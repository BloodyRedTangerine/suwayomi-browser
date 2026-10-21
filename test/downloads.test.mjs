import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';

async function fixture() {
  const store = new MemoryStore(), calls = [], control = { fail: null, empty: false, installed: true, pageCount: 2 };
  const manager = {
    list: async () => [],
    sources: async () => control.installed ? [{ id: 'fixture', name: 'Fixture', lang: 'en' }] : [],
    call: async (_source, operation, args) => {
      calls.push({ operation, args: structuredClone(args) });
      if (operation === 'pages') return Array.from({ length: control.pageCount }, (_, index) => ({ index, url: '', imageUrl: `https://fixture.test${args.chapter.url}/${index}` }));
      if (operation === 'image') {
        if (control.fail && args.pageInfo.imageUrl.endsWith(control.fail)) throw new Error('Fixture image unavailable');
        return { mimeType: 'image/png', body: control.empty ? '' : btoa('image ' + args.pageInfo.imageUrl) };
      }
      throw new Error('Unexpected runtime operation: ' + operation);
    },
  };
  const api = new BrowserBackend(store, { manager, autoDownloads: false }); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/manga', title: 'Fixture' });
  const chapters = await api.rememberChapters(manga, [
    { url: '/newer', name: 'Newer', number: 2, dateUpload: 2000 },
    { url: '/older', name: 'Older', number: 1, dateUpload: 1000 },
  ]);
  await api.save();
  const newer = chapters[0].id, older = chapters[1].id;
  const op = (name, input = {}) => api.resolve(name, { input });
  const step = () => api.coordinated(() => api.downloadStep());
  return { api, store, manager, control, calls, newer, older, op, step };
}
async function drain(api) {
  api.autoDownloads = true;
  await api.kickDownloads();
  for (let count = 0; api.downloadTask && count < 10; count++) await api.downloadTask;
  assert.equal(api.downloadTask, null);
  assert.equal(api.downloadFailure, undefined);
}

test('Queue downloads oldest first, deduplicates, persists pages and emits terminal snapshots', async () => {
  const { api, calls, newer, older, op } = await fixture();
  const result = await op('enqueueChapterDownloads', { ids: [newer, older, older], clientMutationId: 'enqueue' });
  assert.equal(result.clientMutationId, 'enqueue'); assert.equal(result.downloadStatus.state, 'STARTED');
  assert.deepEqual(result.downloadStatus.queue.map(row => row.chapter.id), [older, newer]);
  const initial = await api.resolve('downloadStatusChanged');
  assert.deepEqual(initial.currentChapterIds, [older, newer]); assert.equal(initial.initial.length, 2);
  const progress = [];
  api.listeners.add(() => progress.push(api.downloadStatus().queue.map(row => [row.chapter.id, row.state, row.progress])));
  await drain(api);
  assert.deepEqual(calls.filter(call => call.operation === 'pages').map(call => call.args.chapter.id), [older, newer]);
  assert.equal(calls.filter(call => call.operation === 'image').length, 4);
  assert.equal(api.db.chapters.every(chapter => chapter.isDownloaded), true);
  assert.equal(progress.some(rows => rows.some(row => row[1] === 'DOWNLOADING' && row[2] === 0.5)), true);
  const terminal = await api.resolve('downloadStatusChanged', { knownChapterIds: [older, newer] });
  assert.equal(terminal.initial, null); assert.equal(terminal.state, 'STOPPED');
  assert.deepEqual(terminal.updates.map(update => update.type), ['FINISHED', 'FINISHED']);
  assert.equal(terminal.updates.every(update => update.download.chapter.isDownloaded && update.download.progress === 1), true);
  const before = calls.length;
  await op('enqueueChapterDownloads', { ids: [older, newer] });
  assert.equal(calls.length, before); assert.equal(api.db.downloads.queue.length, 0);
});

test('Automatic new-chapter downloads honor library state and queue real source pages', async () => {
  const { api, older, newer, op, calls } = await fixture();
  await op('updateChapters', { ids: [older, newer], patch: { isRead: true } });
  await op('setSettings', { settings: { autoDownloadNewChapters: true } });
  let manga = api.find('mangas', api.find('chapters', older).mangaId);
  const refreshed = await api.rememberChapters(manga, [
    { url: '/fresh-3', name: 'Fresh 3', number: 3, dateUpload: 3000 },
    { url: '/newer', name: 'Newer', number: 2, dateUpload: 2000 },
    { url: '/older', name: 'Older', number: 1, dateUpload: 1000 },
  ]);
  const fresh = refreshed.find(chapter => chapter.url === '/fresh-3');
  assert.deepEqual(api.db.downloads.queue.map(row => row.chapterId), [fresh.id]);
  assert.equal(api.db.downloads.state, 'STARTED');
  await api.save();
  await drain(api);
  assert.equal(api.find('chapters', fresh.id).isDownloaded, true);
  assert.equal(api.db.downloads.queue.length, 0);
  assert.equal(calls.filter(call => call.operation === 'pages').at(-1).args.chapter.url, '/fresh-3');
});

test('Automatic new-chapter downloads skip excluded categories and unread entries, and apply limits', async () => {
  const { api, older, newer, op } = await fixture();
  const excluded = (await op('createCategory', { name: 'No automatic downloads', includeInDownload: 'EXCLUDE' })).category.id;
  let manga = api.find('mangas', api.find('chapters', older).mangaId);
  manga.categoryIds = [excluded];
  await api.save();
  await op('setSettings', { settings: { autoDownloadNewChapters: true } });
  await api.rememberChapters(manga, [
    { url: '/fresh-3', name: 'Fresh 3', number: 3, dateUpload: 3000 },
    { url: '/newer', name: 'Newer', number: 2, dateUpload: 2000 },
    { url: '/older', name: 'Older', number: 1, dateUpload: 1000 },
  ]);
  await api.save();
  assert.equal(api.db.downloads?.queue.length ?? 0, 0);

  manga = api.find('mangas', manga.id);
  manga.categoryIds = [0];
  await api.save();
  await op('updateChapters', { ids: api.db.chapters.filter(chapter => chapter.mangaId === manga.id).map(chapter => chapter.id), patch: { isRead: true } });
  await op('setSettings', { settings: { autoDownloadNewChaptersLimit: 1, autoDownloadIgnoreReUploads: true } });
  manga = api.find('mangas', manga.id);
  const limited = await api.rememberChapters(manga, [
    { url: '/fresh-4', name: 'Fresh 4', number: 4, dateUpload: 4000 },
    { url: '/fresh-3b', name: 'Fresh 3b', number: 3, dateUpload: 3001, scanlator: 'other' },
    { url: '/fresh-1', name: 'Re-upload 1', number: 1, dateUpload: 3002 },
    { url: '/fresh-3', name: 'Fresh 3', number: 3, dateUpload: 3000 },
    { url: '/newer', name: 'Newer', number: 2, dateUpload: 2000 },
    { url: '/older', name: 'Older', number: 1, dateUpload: 1000 },
  ]);
  await api.save();
  const queued = api.db.downloads.queue.map(row => api.find('chapters', row.chapterId).url);
  assert.deepEqual(queued, ['/fresh-3b']);
  assert.equal(limited.find(chapter => chapter.url === '/fresh-1')?.id > 0, true);
});

test('Stop pauses between requests; reopening resumes cached partial pages without duplicate image fetch', async () => {
  const { api, store, manager, calls, older, op, step } = await fixture();
  await op('enqueueChapterDownload', { id: older });
  await step(); await step(); await step(); // attempt, manifest, first page
  assert.equal(api.db.downloads.queue[0].progress, 0.5);
  await op('stopDownloader');
  assert.equal(await step(), false); assert.equal(api.db.downloads.queue[0].state, 'QUEUED');
  const before = calls.filter(call => call.operation === 'image').length;
  api.dispose();
  const restored = new BrowserBackend(store, { manager, autoDownloads: false }); await restored.loading;
  assert.equal((await restored.resolve('downloadStatus')).state, 'STOPPED');
  await restored.resolve('startDownloader'); await drain(restored);
  assert.equal(calls.filter(call => call.operation === 'image').length, before + 1);
  assert.equal(restored.find('chapters', older).isDownloaded, true);
});

test('Cold STARTED queue resumes automatically and two runners share one leadership lock', async () => {
  const { api, store, manager, calls, older, op, step } = await fixture();
  await op('enqueueChapterDownload', { id: older }); await step(); await step(); await step();
  api.dispose();
  const first = new BrowserBackend(store, { manager }), second = new BrowserBackend(store, { manager });
  await Promise.all([first.loading, second.loading]);
  await Promise.all([drain(first), drain(second)]);
  assert.equal(calls.filter(call => call.operation === 'image').length, 2);
  assert.equal((await first.resolve('downloadStatus')).queue.length, 0);
  assert.equal((await second.resolve('chapter', { id: older })).isDownloaded, true);
});

test('Page failures retain partial bytes, show ERROR/tries and explicit retry completes', async () => {
  const { api, calls, control, older, op } = await fixture();
  control.fail = '/1'; await op('enqueueChapterDownload', { id: older }); await drain(api);
  const status = await api.resolve('downloadStatus');
  assert.equal(status.state, 'STOPPED'); assert.equal(status.queue[0].state, 'ERROR');
  assert.equal(status.queue[0].tries, 1); assert.equal(status.queue[0].progress, 0.5);
  assert.match(status.queue[0].error, /unavailable/); assert.equal(status.queue[0].chapter.isDownloaded, false);
  const imageCalls = calls.filter(call => call.operation === 'image').length;
  control.fail = null; await op('enqueueChapterDownload', { id: older }); await drain(api);
  assert.equal(api.find('chapters', older).isDownloaded, true);
  assert.equal(calls.filter(call => call.operation === 'image').length, imageCalls + 1);
});

test('Failed rows do not retry on reopen; explicit retry-all resumes each row from cached pages', async () => {
  const { api, store, manager, calls, control, older, newer, op } = await fixture();
  control.fail = '/1';
  await op('enqueueChapterDownloads', { ids: [older, newer] }); await drain(api);
  const failed = await api.resolve('downloadStatus');
  assert.deepEqual(failed.queue.map(row => row.state), ['ERROR', 'ERROR']);
  const imageCallsBeforeReopen = calls.filter(call => call.operation === 'image').length;
  api.dispose();

  const reopened = new BrowserBackend(store, { manager, autoDownloads: false }); await reopened.loading;
  await reopened.resolve('downloadStatus');
  assert.equal(calls.filter(call => call.operation === 'image').length, imageCallsBeforeReopen, 'An ERROR row retried automatically after reopen');
  control.fail = null;
  await reopened.resolve('enqueueChapterDownloads', { input: { ids: [older, newer] } });
  await drain(reopened);
  assert.equal(calls.filter(call => call.operation === 'image').length, imageCallsBeforeReopen + 2, 'Retry-all fetched already cached first pages again');
  assert.equal(reopened.db.chapters.filter(chapter => [older, newer].includes(chapter.id)).every(chapter => chapter.isDownloaded), true);
  assert.equal((await reopened.resolve('downloadStatus')).queue.length, 0);
  reopened.dispose();
});

test('Clear/dequeue preserve partial image bytes; subscription diffs remove cancelled entries', async () => {
  const { api, store, older, newer, op, step } = await fixture();
  await op('enqueueChapterDownloads', { ids: [older, newer] }); await step(); await step(); await step();
  const page = await store.get('settings', `webui:page:${older}:0`);
  assert.equal(page.blob.size > 0, true);
  await op('dequeueChapterDownload', { id: older });
  const changed = await api.resolve('downloadStatusChanged', { knownChapterIds: [older, newer] });
  assert.equal(changed.updates.find(update => update.download.chapter.id === older).type, 'DEQUEUED');
  await op('clearDownloader');
  assert.equal(api.db.downloads.state, 'STOPPED'); assert.equal(api.db.downloads.queue.length, 0);
  assert.equal((await store.get('settings', page.key)).blob.size, page.blob.size);
});

test('Delete downloads evicts only selected page blobs, preserving manifest, bookmarks and reading state', async () => {
  const { api, store, older, newer, op } = await fixture();
  await op('enqueueChapterDownloads', { ids: [older, newer] }); await drain(api);
  await op('updateChapter', { id: older, patch: { isBookmarked: true, lastPageRead: 1 } });
  const result = await op('deleteDownloadedChapter', { id: older, clientMutationId: 'remove' });
  assert.equal(result.clientMutationId, 'remove'); assert.equal(result.chapters.isDownloaded, false);
  assert.equal(result.chapters.isBookmarked, true); assert.equal(result.chapters.lastPageRead, 1);
  assert.equal(result.chapters.pageCount, 2); assert.equal(result.chapters.pages.length, 2);
  assert.equal(await store.get('settings', `webui:page:${older}:0`), undefined);
  assert.equal((await store.get('settings', `webui:page:${newer}:0`)).blob.size > 0, true);
  assert.equal((await api.resolve('manga', { id: result.chapters.mangaId })).downloadCount, 1);
});

test('Reorder and invalid queue requests validate all targets before saved edits', async () => {
  const { api, store, older, newer, op } = await fixture();
  await op('enqueueChapterDownloads', { ids: [older, newer] });
  const reordered = await op('reorderChapterDownload', { chapterId: newer, to: 0 });
  assert.deepEqual(reordered.downloadStatus.queue.map(row => row.chapter.id), [newer, older]);
  const before = structuredClone(api.db);
  for (const [name, input] of [
    ['enqueueChapterDownloads', { ids: [older, 999] }],
    ['enqueueChapterDownload', { id: '1' }],
    ['dequeueChapterDownloads', { ids: [-1] }],
    ['reorderChapterDownloads', { reorders: [{ chapterId: older, to: 0 }, { chapterId: 999, to: 1 }] }],
    ['reorderChapterDownload', { chapterId: older, to: -1 }],
    ['deleteDownloadedChapters', { ids: [older, 999] }],
  ]) {
    await assert.rejects(op(name, input));
    assert.deepEqual(api.db, before); assert.deepEqual((await store.get('settings', 'webui:database')).value, before);
  }
});

test('Missing source and empty page/image responses produce retained errors rather than false completion', async () => {
  for (const mode of ['missing', 'pages', 'image']) {
    const { api, control, older, op } = await fixture();
    if (mode === 'missing') control.installed = false;
    if (mode === 'pages') control.pageCount = 0;
    if (mode === 'image') control.empty = true;
    await op('enqueueChapterDownload', { id: older }); await drain(api);
    const status = await api.resolve('downloadStatus');
    assert.equal(status.state, 'STOPPED'); assert.equal(status.queue[0].state, 'ERROR');
    assert.equal(status.queue[0].chapter.isDownloaded, false);
    assert.match(status.queue[0].error, mode === 'missing' ? /not installed/ : /no chapter pages|empty page image/);
  }
});

test('Stop requested during an in-flight image completes that request but starts no following image', async () => {
  const { api, manager, calls, older, op } = await fixture();
  let entered, release;
  const inFlight = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = manager.call;
  manager.call = async (...args) => {
    if (args[1] === 'image') { entered(); await gate; }
    return original(...args);
  };
  await op('enqueueChapterDownload', { id: older }); api.autoDownloads = true;
  const task = api.kickDownloads(); await inFlight;
  const stopped = op('stopDownloader'); release(); await stopped; await task;
  assert.equal(api.db.downloads.state, 'STOPPED');
  assert.equal(calls.filter(call => call.operation === 'image').length, 1);
  assert.equal((await api.cachedChapterPages(api.find('chapters', older))).filter(Boolean).length, 1);
  assert.equal(api.find('chapters', older).isDownloaded, false);
});

test('Disposing an active runner leaves a resumable checkpoint, not a fabricated source error', async () => {
  const { api, manager, store, older, op } = await fixture();
  let entered, release;
  const inFlight = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = manager.call;
  manager.call = async (...args) => {
    if (args[1] === 'image') { entered(); await gate; throw new Error('Runtime disposed'); }
    return original(...args);
  };
  await op('enqueueChapterDownload', { id: older }); api.autoDownloads = true;
  const task = api.kickDownloads(); await inFlight;
  api.dispose(); release(); await task;
  const saved = (await store.get('settings', 'webui:database')).value;
  assert.equal(saved.downloads.state, 'STARTED'); assert.equal(saved.downloads.queue[0].state, 'DOWNLOADING');
  assert.equal(saved.downloads.queue[0].error, undefined);
  manager.call = original;
  const restored = new BrowserBackend(store, { manager, autoDownloads: false }); await restored.loading;
  await drain(restored);
  assert.equal(restored.find('chapters', older).isDownloaded, true);
});

test('Persistence failure is observable and does not spin; a successful explicit restart recovers', async () => {
  const { api, store, older, op } = await fixture();
  await op('enqueueChapterDownload', { id: older });
  const put = store.put.bind(store); let attempts = 0;
  store.put = async () => { attempts++; throw new Error('Fixture storage quota exceeded'); };
  api.autoDownloads = true; await api.kickDownloads();
  assert.match(api.downloadFailure.message, /quota/); assert.equal(api.downloadTask, null);
  assert.equal(attempts, 2); // Attempt checkpoint and attempted error checkpoint.
  await assert.rejects(api.resolve('downloadStatus'), /Local downloader failed.*quota/);
  assert.equal(attempts, 2);
  store.put = put;
  await op('startDownloader'); await drain(api);
  assert.equal(api.find('chapters', older).isDownloaded, true);
});

test('QuotaExceededError produces a retryable ERROR row without corrupting the library', async () => {
  const { api, store, older, op } = await fixture();
  const put = store.put.bind(store);
  store.put = async (name, value) => {
    if (name === 'settings' && value.key?.startsWith('webui:page:'))
      throw new DOMException('IndexedDB quota exceeded', 'QuotaExceededError');
    return put(name, value);
  };
  await op('enqueueChapterDownload', { id: older });
  await drain(api);
  const status = await api.resolve('downloadStatus');
  assert.equal(status.queue[0].state, 'ERROR');
  assert.match(status.queue[0].error, /Browser storage quota exceeded/);
  assert.equal(status.queue[0].tries, 1);
  assert.equal(status.queue[0].chapter.isDownloaded, false);
  assert.deepEqual(await store.getKeysByPrefix('settings', `webui:page:${older}:`), []);
  const saved = (await store.get('settings', 'webui:database')).value;
  assert.equal(saved.mangas.length, 1);
  assert.equal(saved.chapters.find(chapter => chapter.id === older).isDownloaded, false);
  assert.equal(saved.downloads.queue[0].state, 'ERROR');
});

test('Source removal mid-download retains readable cached pages and records one manual-retry error', async () => {
  const { api, store, control, older, op, step } = await fixture();
  await op('enqueueChapterDownload', { id: older });
  await step(); await step(); await step();
  const cached = await store.get('settings', `webui:page:${older}:0`);
  assert.ok(cached?.blob.size);
  control.installed = false;
  await step();
  const status = await api.resolve('downloadStatus');
  assert.equal(status.queue[0].state, 'ERROR');
  assert.match(status.queue[0].error, /not installed/);
  assert.equal(status.queue[0].chapter.isDownloaded, false);
  const offlinePage = await api.fetch(`/browser-local/chapter/${older}/page/0`);
  assert.equal(offlinePage.status, 200);
  assert.equal((await offlinePage.blob()).size, cached.blob.size);
  assert.equal((await store.getKeysByPrefix('settings', `webui:page:${older}:`)).length, 1);
});

test('A queued chapter removed by another tab drops its queue row and cached page keys', async () => {
  const { api, store, older, op, step } = await fixture();
  await op('enqueueChapterDownload', { id: older });
  await step(); await step(); await step();
  assert.equal((await store.getKeysByPrefix('settings', `webui:page:${older}:`)).length, 1);

  const saved = (await store.get('settings', 'webui:database')).value;
  saved.chapters = saved.chapters.filter(chapter => chapter.id !== older);
  await store.put('settings', { key: 'webui:database', value: saved });
  await step();

  assert.equal((await api.resolve('downloadStatus')).queue.length, 0);
  assert.equal((await store.getKeysByPrefix('settings', `webui:page:${older}:`)).length, 0);
  assert.equal((await store.get('settings', 'webui:database')).value.chapters.some(chapter => chapter.id === older), false);
});
