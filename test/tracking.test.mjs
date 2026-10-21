import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';

function manager() {
  return {
    list: async () => [],
    sources: async () => [{ id: 'source-a', name: 'Source A', lang: 'en', baseUrl: 'https://source-a.test' }],
    call: async () => { throw new Error('Tracking test does not execute source operations'); },
  };
}

async function seeded() {
  const store = new MemoryStore();
  const api = new BrowserBackend(store, { manager: manager(), autoDownloads: false, autoUpdates: false });
  await api.loading;
  const manga = api.rememberManga('source-a', { url: '/saved', realUrl: 'https://source-a.test/saved', title: 'Saved Manga', description: 'A local test manga' });
  manga.inLibrary = true;
  const chapters = await api.rememberChapters(manga, [
    { url: '/saved/1', name: 'Chapter 1', number: 1, dateUpload: 1000 },
    { url: '/saved/2', name: 'Chapter 2', number: 2, dateUpload: 2000 },
  ]);
  await api.save();
  return { api, store, manga, chapters };
}

test('Local tracker supports search, bind, progress, editing and unbind', async () => {
  const { api, manga, chapters } = await seeded();
  const trackers = await api.resolve('trackers', {});
  assert.deepEqual(trackers.nodes.map(tracker => [tracker.id, tracker.name, tracker.isLoggedIn]), [[0, 'Local progress', true]]);
  assert.deepEqual(trackers.nodes[0].statuses.map(status => status.value), [1, 2, 3, 4, 5]);

  const search = await api.resolve('searchTracker', { input: { query: 'saved', trackerId: 0 } });
  assert.equal(search.trackSearches.length, 1);
  assert.equal(search.trackSearches[0].remoteId, String(manga.id));
  assert.equal(search.trackSearches[0].totalChapters, 2);

  const bound = await api.resolve('bindTrack', { input: { mangaId: manga.id, trackerId: 0, remoteId: String(manga.id), private: true, clientMutationId: 'bind' } });
  assert.equal(bound.clientMutationId, 'bind');
  assert.equal(bound.trackRecord.trackerId, 0);
  assert.equal(bound.trackRecord.private, true);
  assert.equal((await api.resolve('manga', { id: manga.id })).trackRecords.totalCount, 1);

  const edited = await api.resolve('updateTrack', { input: { recordId: bound.trackRecord.id, status: 4, scoreString: '4', startDate: '1767312000000', finishDate: '0', private: false, clientMutationId: 'edit' } });
  assert.equal(edited.clientMutationId, 'edit');
  assert.equal(edited.trackRecord.status, 4);
  assert.equal(edited.trackRecord.score, 4);
  assert.equal(edited.trackRecord.startDate, '1767312000000');
  assert.equal(edited.trackRecord.private, false);

  await api.resolve('updateChapter', { input: { id: chapters[0].id, patch: { isRead: true } } });
  const progress = await api.resolve('trackProgress', { input: { mangaId: manga.id, clientMutationId: 'progress' } });
  assert.equal(progress.clientMutationId, 'progress');
  assert.equal(progress.trackRecords[0].lastChapterRead, 1);
  assert.equal(progress.trackRecords[0].totalChapters, 2);
  assert.equal(progress.trackRecords[0].status, 2);
  assert.match(progress.trackRecords[0].startDate, /^\d+$/);
  assert.notEqual(progress.trackRecords[0].startDate, '0');
  assert.equal(progress.trackRecords[0].finishDate, '0');

  await api.resolve('updateChapter', { input: { id: chapters[1].id, patch: { isRead: true } } });
  const completed = await api.resolve('trackProgress', { input: { mangaId: manga.id } });
  assert.equal(completed.trackRecords[0].lastChapterRead, 2);
  assert.equal(completed.trackRecords[0].status, 3);
  assert.match(completed.trackRecords[0].finishDate, /^\d+$/);

  const removed = await api.resolve('unbindTrack', { input: { recordId: bound.trackRecord.id, clientMutationId: 'remove' } });
  assert.equal(removed.clientMutationId, 'remove');
  assert.equal(removed.trackRecord.id, bound.trackRecord.id);
  assert.equal((await api.resolve('manga', { id: manga.id })).trackRecords.totalCount, 0);
  api.dispose();
});

test('Local tracker records persist and round-trip through browser backup', async () => {
  const { api, store, manga } = await seeded();
  await api.resolve('bindTrack', { input: { mangaId: manga.id, trackerId: 0, remoteId: String(manga.id) } });
  const created = await api.resolve('createBackup', { input: {} });
  const backup = await (await api.fetch(created.url)).blob();
  const payload = JSON.parse(await backup.text());
  assert.equal(payload.trackRecords.length, 1);
  assert.equal(payload.trackRecords[0].mangaId, manga.id);

  api.db.trackRecords = [];
  await api.save();
  const restored = await api.resolve('restoreBackup', { input: { backup } });
  assert.equal(restored.status.state, 'SUCCESS');
  assert.equal(api.db.trackRecords.length, 1);
  assert.equal(api.db.trackRecords[0].remoteId, String(manga.id));

  const peer = new BrowserBackend(store, { manager: manager(), autoDownloads: false, autoUpdates: false });
  await peer.loading;
  const records = await peer.resolve('trackRecords', {});
  assert.equal(records.totalCount, 1);
  assert.equal(records.nodes[0].tracker().id, 0);
  peer.dispose();
  api.dispose();
});

test('Remote tracker operations remain explicit instead of claiming account parity', async () => {
  const { api, manga } = await seeded();
  await assert.rejects(api.resolve('searchTracker', { input: { query: 'saved', trackerId: 1 } }), /not available in the browser-local backend/);
  await assert.rejects(api.resolve('bindTrack', { input: { mangaId: manga.id, trackerId: 1, remoteId: '1' } }), /not available in the browser-local backend/);
  await assert.rejects(api.resolve('loginTrackerCredentials', { input: { trackerId: 1, username: 'u', password: 'p' } }), /has not implemented loginTrackerCredentials/);
  api.dispose();
});
