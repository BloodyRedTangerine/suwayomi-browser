import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend, connection } from '../src/webui/backend.mjs';
import { normalizeVariables } from '../src/webui/variables.mjs';

test('Local GraphQL omits undefined filters without destroying extension Upload files', () => {
  const file = new Blob(['extension bytes']);
  const variables = normalizeVariables({ file, filter: { categoryId: { isNull: true, in: undefined } }, list: [undefined] });
  assert.equal(variables.file, file);
  assert.deepEqual(variables.filter, { categoryId: { isNull: true } });
  assert.deepEqual(variables.list, [null]);
});

test('Official settings screens receive browser-safe string defaults', async () => {
  const { api } = backend(); await api.loading;
  const settings = await api.resolve('settings', {});
  assert.equal(settings.localSourcePath, '');
  assert.equal(settings.electronPath, '');
  assert.equal(settings.downloadsPath, '');
});

test('About server reports the installed browser extension version', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.3.0' }) } };
  try {
    const { api } = backend(); await api.loading;
    assert.equal((await api.resolve('aboutServer', {})).version, '0.3.0');
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('Bundled browser WebUI update status is local, idle, and never advertises desktop updates', async () => {
  const { api } = backend(); await api.loading;
  assert.deepEqual(await api.resolve('checkForServerUpdates', {}), []);
  assert.deepEqual(await api.resolve('checkForWebUIUpdate', {}), {
    __typename: 'WebUIUpdateCheck', channel: 'BUNDLED', tag: 'r3541', updateAvailable: false,
  });
  const expectedStatus = {
    __typename: 'WebUIUpdateStatus',
    info: { __typename: 'WebUIUpdateInfo', channel: 'BUNDLED', tag: 'r3541' },
    progress: 0, state: 'IDLE',
  };
  assert.deepEqual(await api.resolve('getWebUIUpdateStatus', {}), expectedStatus);
  assert.deepEqual(await api.resolve('resetWebUIUpdateStatus', {}), expectedStatus);
});

function backend() {
  const store = new MemoryStore();
  const manager = {
    list: async () => [],
    sources: async () => [{ id: '8061953015808280611', name: 'Fixture', lang: 'en', baseUrl: 'https://example.test' }],
    call: async (_id, operation, args) => {
      switch (operation) {
        case 'popular': case 'search': return { mangas: [{ url: '/comic/test', title: 'Test', thumbnailUrl: 'https://example.test/cover.png' }], hasNextPage: false };
        case 'details': return { title: 'Test', url: '/comic/test', author: 'Author', genre: 'A, B', status: 2 };
        case 'chapters': return [{ url: '/chapter/test', name: 'One', number: 1, dateUpload: 1000 }];
        case 'update': return { manga: args.fetchDetails ? { title: 'Test', url: '/comic/test', author: 'Author', genre: 'A, B', status: 2 } : args.manga, chapters: args.fetchChapters ? [{ url: '/chapter/test', name: 'One', number: 1, dateUpload: 1000 }] : [] };
        case 'pages': return [{ index: 0, url: '', imageUrl: 'https://example.test/page.png' }];
        case 'image': case 'thumbnail': return { mimeType: 'image/png', body: btoa('test image bytes') };
        default: throw new Error('unexpected operation');
      }
    },
  };
  return { api: new BrowserBackend(store, { manager }), store, manager };
}

test('Category CRUD persists names, landing flags, three-state inclusion and Unicode metadata', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const created = await api.resolve('createCategory', { input: { name: '日本語 🔒', default: true, includeInUpdate: 'EXCLUDE', clientMutationId: 'create' } });
  assert.equal(created.clientMutationId, 'create');
  const id = created.category.id;
  assert.equal(created.category.order, 1); assert.equal(created.category.default, true);
  assert.equal(created.category.includeInUpdate, 'EXCLUDE'); assert.equal(created.category.includeInDownload, 'UNSET');
  await api.resolve('setCategoryMetas', { input: { items: [{ categoryIds: [id], metas: [{ key: 'reader', value: '😀' }] }] } });
  const updated = await api.resolve('updateCategory', { input: { id, patch: { name: 'Renamed', default: false, includeInDownload: 'INCLUDE' }, clientMutationId: 'update' } });
  assert.equal(updated.category.name, 'Renamed'); assert.equal(updated.category.default, false);
  assert.equal(updated.category.includeInDownload, 'INCLUDE'); assert.equal(updated.clientMutationId, 'update');
  const restored = new BrowserBackend(store, { manager }); await restored.loading;
  const category = await restored.resolve('category', { id });
  assert.equal(category.name, 'Renamed'); assert.equal(category.meta[0].value, '😀');
  assert.equal(category.includeInUpdate, 'EXCLUDE');
  const defaults = await restored.resolve('category', { id: 0 });
  assert.equal(defaults.default, false); assert.equal(defaults.includeInUpdate, 'UNSET');
});

test('Category insert/reorder normalizes collisions, pins Default and clamps end positions', async () => {
  const { api } = backend(); await api.loading;
  const create = async input => (await api.resolve('createCategory', { input })).category.id;
  const a = await create({ name: 'A' }), b = await create({ name: 'B' });
  const c = await create({ name: 'C', order: 1 });
  const rows = async () => (await api.resolve('categories', { order: [{ by: 'ORDER' }] })).nodes;
  assert.deepEqual((await rows()).map(category => category.id), [0, c, a, b]);
  // Imported/synced order values need not be contiguous or unique.
  api.db.categories.filter(category => category.id !== 0).forEach(category => { category.order = 4; }); await api.save();
  const moved = await api.resolve('updateCategoryOrder', { input: { id: b, position: 1, clientMutationId: 'move' } });
  assert.equal(moved.clientMutationId, 'move');
  assert.deepEqual(moved.categories.map(category => category.id), [0, b, a, c]);
  assert.deepEqual(moved.categories.map(category => category.order), [0, 1, 2, 3]);
  await api.resolve('updateCategoryOrder', { input: { id: b, position: 999 } });
  assert.deepEqual((await rows()).map(category => category.id), [0, a, c, b]);
  await api.resolve('updateCategoryOrder', { input: { id: 0, position: 2 } });
  await api.resolve('updateCategoryOrder', { input: { id: 999, position: 2 } });
  assert.deepEqual((await rows()).map(category => category.id), [0, a, c, b]);
});

test('Bulk category update protects built-in name/landing flag but updates inclusion settings', async () => {
  const { api } = backend(); await api.loading;
  const { category } = await api.resolve('createCategory', { input: { name: 'A' } });
  const result = await api.resolve('updateCategories', { input: { ids: [0, category.id, category.id], patch: { name: 'Renamed', default: true, includeInUpdate: 'INCLUDE', includeInDownload: 'EXCLUDE' } } });
  assert.equal(result.categories.length, 2);
  assert.deepEqual(result.categories.map(row => [row.name, row.default, row.includeInUpdate, row.includeInDownload]), [['Default', false, 'INCLUDE', 'EXCLUDE'], ['Renamed', true, 'INCLUDE', 'EXCLUDE']]);
  const before = structuredClone(api.db);
  await api.resolve('updateCategory', { input: { id: category.id, patch: { name: null, default: null } } });
  assert.deepEqual(api.db, before);
});

test('Deleting category cascades memberships, retains manga/chapter/cache and falls back to Default', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const create = async name => (await api.resolve('createCategory', { input: { name } })).category.id;
  const a = await create('A'), b = await create('B');
  const first = api.rememberManga('fixture', { url: '/one', title: 'One' }), second = api.rememberManga('fixture', { url: '/two', title: 'Two' });
  Object.assign(first, { inLibrary: true, categoryIds: [a] });
  Object.assign(second, { inLibrary: true, categoryIds: [a, b] });
  const [chapter] = await api.rememberChapters(first, [{ url: '/one', name: 'One', number: 1, dateUpload: 1000 }]);
  await store.put('settings', { key: `webui:page:${chapter.id}:0`, blob: new Blob(['cached']) }); await api.save();
  const result = await api.resolve('deleteCategory', { input: { categoryId: a, clientMutationId: 'delete' } });
  assert.equal(result.clientMutationId, 'delete'); assert.equal(result.category.id, a);
  assert.deepEqual(result.mangas.map(manga => manga.categories().nodes.map(category => category.id)), [[0], [b]]);
  assert.equal(api.db.chapters.length, 1); assert.equal((await store.get('settings', `webui:page:${chapter.id}:0`)).blob.size, 6);
  assert.deepEqual(api.db.categories.map(category => category.order), [0, 1]);
  const restored = new BrowserBackend(store, { manager }); await restored.loading;
  assert.deepEqual(restored.db.mangas.map(manga => manga.categoryIds), [[0], [b]]);
  assert.equal((await restored.resolve('deleteCategory', { input: { categoryId: a } })).category, null);
  assert.equal((await restored.resolve('deleteCategory', { input: { categoryId: 0 } })).category, null);
  assert.equal(restored.db.categories.length, 2);
});

test('Malformed category requests reject before any persisted or in-memory edits', async () => {
  const { api, store } = backend(); await api.loading;
  const { category } = await api.resolve('createCategory', { input: { name: 'A' } });
  const before = structuredClone(api.db);
  for (const [operation, input] of [
    ['createCategory', { name: 'DEFAULT' }], ['createCategory', { name: 'A' }],
    ['createCategory', { name: 'x'.repeat(65) }], ['createCategory', { name: 'B', order: 0 }],
    ['createCategory', { name: 'B', default: 'true' }], ['createCategory', { name: 'B', includeInDownload: true }],
    ['updateCategory', { id: category.id, patch: { order: 8 } }],
    ['updateCategories', { ids: [category.id, 999], patch: { name: 'changed' } }],
    ['updateCategories', { ids: [category.id], patch: { name: 'changed', includeInUpdate: 'bad' } }],
    ['updateCategoryOrder', { id: category.id, position: 0 }],
    ['updateCategoryOrder', { id: category.id, position: 1.5 }],
    ['deleteCategory', { categoryId: '1' }],
  ]) {
    await assert.rejects(api.resolve(operation, { input }));
    assert.deepEqual(api.db, before); assert.deepEqual((await store.get('settings', 'webui:database')).value, before);
  }
});

test('Legacy category booleans surface as enums without resetting saved library records', async () => {
  const { api } = backend(); await api.loading;
  Object.assign(api.db.categories[0], { default: true, includeInUpdate: true, includeInDownload: false }); await api.save();
  const category = await api.resolve('category', { id: 0 });
  assert.equal(category.default, false); assert.equal(category.includeInUpdate, 'INCLUDE'); assert.equal(category.includeInDownload, 'EXCLUDE');
});

test('Category landing flags drive the official category-then-membership add sequence', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const first = await api.resolve('createCategory', { input: { name: 'Landing A', default: true } });
  const second = await api.resolve('createCategory', { input: { name: 'Landing B', default: true } });
  await api.resolve('createCategory', { input: { name: 'Other' } });
  const manga = api.rememberManga('fixture', { url: '/landing', title: 'Landing Test' }); await api.save();
  const defaults = (await api.resolve('categories', { condition: { default: true } })).nodes.map(category => category.id);
  assert.deepEqual(defaults, [first.category.id, second.category.id]);
  await api.resolve('updateMangaCategories', { input: { id: manga.id, patch: { addToCategories: defaults } } });
  await api.resolve('updateManga', { input: { id: manga.id, patch: { inLibrary: true } } });
  const restored = new BrowserBackend(store, { manager }); await restored.loading;
  assert.deepEqual(restored.manga(restored.find('mangas', manga.id)).categories().nodes.map(category => category.id), defaults);
  assert.equal(restored.category(restored.find('categories', defaults[0])).mangas({}).totalCount, 1);
});

test('Two backend instances serialize category IDs and preserve concurrent edits', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const peer = new BrowserBackend(store, { manager }); await peer.loading;
  const [first, second] = await Promise.all([
    api.resolve('createCategory', { input: { name: 'First' } }),
    peer.resolve('createCategory', { input: { name: 'Second' } }),
  ]);
  assert.notEqual(first.category.id, second.category.id);
  await Promise.all([
    api.resolve('updateCategory', { input: { id: first.category.id, patch: { name: 'First edited' } } }),
    peer.resolve('updateCategory', { input: { id: second.category.id, patch: { default: true } } }),
  ]);
  const rows = (await api.resolve('categories', {})).nodes;
  assert.equal(rows.length, 3); assert.equal(rows.find(row => row.id === first.category.id).name, 'First edited');
  assert.equal(rows.find(row => row.id === second.category.id).default, true);
});

test('Chapter refresh preserves fetch dates, local state and cache while applying source metadata', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const [first] = await api.rememberChapters(manga, [{ url: '/one', name: 'One', number: 1, dateUpload: 1234 }]);
  const saved = api.find('chapters', first.id);
  Object.assign(saved, { fetchedAt: 42, isRead: true, isBookmarked: true, lastReadAt: 55, lastPageRead: 3, isDownloaded: true, pageCount: 4, pages: [{ imageUrl: 'cached' }], meta: [{ key: 'reader', value: 'saved' }] });
  const [updated] = await api.rememberChapters(manga, [{ url: '/one', name: 'Renamed', number: 1.5, dateUpload: 0, memo: { token: 'new' }, realUrl: 'https://example.test/one', id: 999, mangaId: 999, isRead: false, isDownloaded: false, fetchedAt: 999, pages: [] }]);
  assert.equal(updated.id, first.id); assert.equal(updated.mangaId, manga.id);
  assert.equal(updated.name, 'Renamed'); assert.equal(updated.chapterNumber, 1.5);
  assert.equal(updated.uploadDate, 1234); assert.equal(updated.dateUpload, 1234);
  assert.equal(updated.fetchedAt, 42); assert.equal(updated.isRead, true);
  assert.equal(updated.isBookmarked, true); assert.equal(updated.lastReadAt, 55);
  assert.equal(updated.lastPageRead, 3); assert.equal(updated.isDownloaded, true);
  assert.equal(updated.pageCount, 4); assert.deepEqual(updated.pages, [{ imageUrl: 'cached' }]);
  assert.deepEqual(updated.meta, [{ key: 'reader', value: 'saved' }]);
  assert.deepEqual(api.sourceChapters(manga.id)[0].memo, { token: 'new' });
  await api.save(); const restored = new BrowserBackend(store, { manager }); await restored.loading;
  assert.equal(restored.find('chapters', first.id).fetchedAt, 42);
  assert.equal(restored.find('chapters', first.id).uploadDate, 1234);
  await api.rememberChapters(manga, [{ url: '/one', name: 'One', number: 1, dateUpload: 5678 }]);
  assert.equal(api.find('chapters', first.id).uploadDate, 5678); assert.equal(api.find('chapters', first.id).fetchedAt, 42);
});

test('Chapter insertion follows upstream oldest-first upload fallback and first-URL deduplication', async () => {
  const { api } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const make = (url, dateUpload, name = url) => ({ url, name, number: 1, dateUpload });
  const before = Date.now();
  const chapters = await api.rememberChapters(manga, [make('/newest', 0), make('/dated', 2000), make('/dated', 9999, 'duplicate'), make('/middle', 0), make('/oldest', 1000)]);
  assert.deepEqual(chapters.map(chapter => chapter.url), ['/newest', '/dated', '/middle', '/oldest']);
  assert.deepEqual(chapters.map(chapter => chapter.sourceOrder), [4, 3, 2, 1]);
  assert.deepEqual(chapters.map(chapter => chapter.uploadDate), [2000, 2000, 1000, 1000]);
  assert.equal(chapters[1].name, '/dated');
  assert.equal(api.manga(manga).firstUnreadChapter.url, '/oldest');
  assert.equal(manga.chaptersLastFetchedAt >= Math.floor(before / 1000), true);
  const [undated] = await api.rememberChapters(manga, [make('/undated', 0)]);
  assert.equal(undated.uploadDate >= before && undated.uploadDate <= Date.now(), true);
  const snapshot = structuredClone(api.db);
  await assert.rejects(api.rememberChapters(manga, [make('/valid', 1), { url: '/invalid', name: 'Invalid', number: NaN, dateUpload: 0 }]), /invalid chapter/);
  assert.deepEqual(api.db, snapshot);
});

test('Malformed chapter response cannot partially commit combined manga details', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Before', author: 'Original' });
  await api.save();
  const snapshot = structuredClone(api.db);
  manager.call = async () => ({ manga: { ...manga, title: 'After', author: 'Changed' }, chapters: [{ url: '/chapter', name: 'Invalid', number: 1, dateUpload: null }] });
  await assert.rejects(api.resolve('fetchMangaAndChapters', { input: { id: manga.id, fetchManga: true, fetchChapters: true } }), /invalid chapter/);
  assert.deepEqual(api.db, snapshot);
  await api.save();
  const restored = new BrowserBackend(store, { manager }); await restored.loading;
  assert.deepEqual(restored.db, snapshot);
});

test('WebUI connection honors filter, order, offset and total count', () => {
  const result = connection('Manga', [{ id: 1, inLibrary: true }, { id: 2, inLibrary: false }, { id: 3, inLibrary: true }], { condition: { inLibrary: true }, order: [{ by: 'ID', direction: 'DESC' }], first: 1 });
  assert.equal(result.totalCount, 2);
  assert.equal(result.nodes[0].id, 3);
  assert.equal(result.pageInfo.hasNextPage, true);
});

test('Official add-to-library category mutation and membership survive reload', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/series-a', title: 'Fixture test' });
  await api.save();
  // Exact root-field ordering used by official UPDATE_MANGA, even with no categories.
  const categories = await api.resolve('updateMangaCategories', { input: { id: manga.id, patch: { addToCategories: [], removeFromCategories: [] } } });
  assert.deepEqual(categories.manga.categories().nodes.map(category => category.id), [0]);
  const added = await api.resolve('updateManga', { input: { id: manga.id, patch: { inLibrary: true } } });
  assert.equal(added.manga.inLibrary, true);
  const reopened = new BrowserBackend(store, { manager }); await reopened.loading;
  assert.equal(reopened.find('mangas', manga.id).inLibrary, true);
  assert.equal(reopened.category(reopened.find('categories', 0)).mangas({}).totalCount, 1);
  await reopened.resolve('updateMangasCategories', { input: { ids: [manga.id], patch: { clearCategories: true } } });
  await reopened.resolve('updateMangas', { input: { ids: [manga.id], patch: { inLibrary: false } } });
  const removed = new BrowserBackend(store, { manager }); await removed.loading;
  assert.equal(removed.find('mangas', manga.id).inLibrary, false);
});

test('Category membership supports bulk clear/remove/add and rejects invalid input before writes', async () => {
  const { api, store } = backend(); await api.loading;
  api.db.categories.push({ id: 8, name: 'A' }, { id: 9, name: 'B' });
  const first = api.rememberManga('fixture', { url: '/one', title: 'One' });
  const second = api.rememberManga('fixture', { url: '/two', title: 'Two' });
  await api.save();
  const ids = [first.id, second.id];
  const result = await api.resolve('updateMangasCategories', { input: { ids, clientMutationId: 'bulk', patch: { addToCategories: [0, 8, 8] } } });
  assert.equal(result.clientMutationId, 'bulk');
  assert.deepEqual(result.mangas.map(manga => manga.categories().nodes.map(category => category.id)), [[8], [8]]);
  await api.resolve('updateMangasCategories', { input: { ids, patch: { removeFromCategories: [8], addToCategories: [9] } } });
  assert.deepEqual(api.db.mangas.map(manga => manga.categoryIds), [[9], [9]]);
  await api.resolve('updateMangasCategories', { input: { ids, patch: { clearCategories: true, addToCategories: [8] } } });
  assert.deepEqual(api.db.mangas.map(manga => manga.categoryIds), [[8], [8]]);
  const before = structuredClone((await store.get('settings', 'webui:database')).value);
  for (const input of [
    { ids, patch: { clearCategories: true, addToCategories: [999] } },
    { ids: [first.id, 999], patch: { clearCategories: true } },
    { ids, patch: { addToCategories: '8' } },
    { ids, patch: { clearCategories: 'true' } },
  ]) await assert.rejects(api.resolve('updateMangasCategories', { input }));
  assert.deepEqual((await store.get('settings', 'webui:database')).value, before);
});

test('Official History LongString filter excludes unread zero/null timestamps and sorts recent reads', () => {
  const chapters = [{ id: 1, lastReadAt: 0 }, { id: 2, lastReadAt: null }, { id: 3 }, { id: 4, lastReadAt: 100, sourceOrder: 1 }, { id: 5, lastReadAt: 200, sourceOrder: 1 }, { id: 6, lastReadAt: 200, sourceOrder: 2 }];
  const history = connection('Chapter', chapters, {
    filter: { lastReadAt: { isNull: false, notEqualToAll: ['0'] } },
    order: [{ by: 'LAST_READ_AT', byType: 'DESC' }, { by: 'SOURCE_ORDER', byType: 'DESC' }],
  });
  assert.deepEqual(history.nodes.map(chapter => chapter.id), [6, 5, 4]);
  assert.equal(history.totalCount, 3);
});

test('Negated ALL/ANY match upstream OR/AND semantics, empty clauses and exact integer inputs', () => {
  const rows = [{ id: 1, value: 1 }, { id: 2, value: 2 }, { id: 3, value: 3 }, { id: 4, value: null }];
  const ids = filter => connection('Row', rows, { filter: { value: filter } }).nodes.map(row => row.id);
  assert.deepEqual(ids({ notEqualToAll: [1, 2] }), [1, 2, 3]);
  assert.deepEqual(ids({ notEqualToAny: [1, 2] }), [3]);
  assert.deepEqual(ids({ notEqualToAll: [] }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ notEqualToAny: [] }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ notEqualToAll: ['01'] }), [2, 3]);
  const maximum = [{ id: 1, value: Number.MAX_SAFE_INTEGER }];
  assert.equal(connection('Row', maximum, { filter: { value: { notEqualToAll: ['9007199254740991'] } } }).totalCount, 0);
  assert.equal(connection('Row', maximum, { filter: { value: { notEqualToAll: ['9007199254740992'] } } }).totalCount, 1);
  assert.throws(() => ids({ notEqualToAll: '0' }), /array/);
});

test('Numeric comparison filters include inclusive bounds used by extension stores', () => {
  const rows = [{ id: 1, value: 1 }, { id: 2, value: 2 }, { id: 3, value: 3 }];
  const ids = filter => connection('Row', rows, { filter: { value: filter } }).nodes.map(row => row.id);
  assert.deepEqual(ids({ greaterThanOrEqualTo: 2 }), [2, 3]);
  assert.deepEqual(ids({ lessThanOrEqualTo: 2 }), [1, 2]);
});

test('Manga activity and highest completed chapter follow distinct upstream rankings', async () => {
  const { api } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/resume', title: 'Resume' });
  assert.equal(api.manga(manga).lastReadChapter, null);
  assert.equal(api.manga(manga).latestReadChapter, null);
  api.db.chapters = [
    { id: 10, mangaId: manga.id, sourceOrder: 1, lastReadAt: 500, isRead: true },
    { id: 11, mangaId: manga.id, sourceOrder: 2, lastReadAt: 100, isRead: true },
    { id: 12, mangaId: manga.id, sourceOrder: 3, lastReadAt: 600, lastPageRead: 1, isRead: false },
  ];
  let projected = api.manga(manga);
  assert.equal(projected.lastReadChapter.id, 12);
  assert.equal(projected.lastReadChapter.lastPageRead, 1);
  assert.equal(projected.latestReadChapter.id, 11);
  assert.equal(projected.firstUnreadChapter.id, 12);
  api.db.chapters[0].lastReadAt = 700; // Re-reading an older completed chapter.
  projected = api.manga(manga);
  assert.equal(projected.lastReadChapter.id, 10);
  assert.equal(projected.latestReadChapter.id, 11);
  api.db.chapters[1].lastReadAt = 700;
  assert.equal(api.manga(manga).lastReadChapter.id, 11); // timestamp tie: source order
  api.db.chapters.forEach(chapter => { chapter.isRead = false; chapter.lastReadAt = null; });
  api.db.chapters[0].lastReadAt = 0; // explicit zero still sorts before SQL NULL
  assert.equal(api.manga(manga).lastReadChapter.id, 10);
  assert.equal(api.manga(manga).latestReadChapter, null);
});

test('Official category join filters omit undefined inputs and honor byType ordering', () => {
  const mangas = [{ id: 1, inLibrary: true, categoryIds: [0] }, { id: 2, inLibrary: true, categoryIds: [3] }, { id: 3, inLibrary: true, categoryIds: [0] }];
  const defaults = connection('Manga', mangas, { filter: { inLibrary: { equalTo: true }, categoryId: { isNull: true, in: undefined } }, order: [{ by: 'ID', byType: 'DESC' }] });
  assert.deepEqual(defaults.nodes.map(manga => manga.id), [3, 1]);
  assert.equal(connection('Manga', mangas, { filter: { categoryId: { isNull: false, in: [3] } } }).nodes[0].id, 2);
});

test('Detail pages without covers preserve previously discovered thumbnails', async () => {
  const { api } = backend();
  await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test', thumbnailUrl: 'https://example.test/cover.png' });
  api.rememberManga('fixture', { url: '/comic', title: 'Test', thumbnailUrl: null });
  assert.equal(manga.thumbnailUrl, 'https://example.test/cover.png');
});

test('Official manga genre field is a non-null list even when a source has no genres', async () => {
  const { api } = backend(); await api.loading;
  for (const [genre, expected] of [[null, []], ['', []], [[], []], [' A, B ', ['A', 'B']], [[' A ', null, ''], ['A']]]) {
    const record = api.rememberManga('fixture', { url: '/no-genres', title: 'Test', genre });
    assert.deepEqual(api.manga(record).genre, expected);
  }
});

test('Existing 0.2.7 null-genre records render safely before details fetch, without rewriting the library', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const manga = api.rememberManga('2499283573021220255', { url: '/legacy-series', title: 'Existing fixture record', genre: null });
  await api.save();
  const before = await store.get('settings', 'webui:database');
  manager.call = async () => { throw new Error('No source execution needed to read legacy records'); };
  const current = new BrowserBackend(store, { manager });
  const record = await current.resolve('manga', { id: manga.id });
  // The official DescriptionGenre component calls this during initial render,
  // before its asynchronous source refresh can populate the remaining fields.
  assert.deepEqual(record.genre.filter(Boolean), []);
  assert.equal((await current.resolve('mangas')).nodes[0].title, 'Existing fixture record');
  assert.deepEqual(await store.get('settings', 'webui:database'), before);
});

test('Source list refresh does not erase initialized library details or source memo', async () => {
  const { api } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test', author: 'Author', artist: 'Artist', description: 'Details', genre: 'Adventure', status: 2, memo: { token: 'fixture' } });
  manga.initialized = true; manga.inLibrary = true;
  api.rememberManga('fixture', { url: '/comic', title: 'Updated title', author: null, artist: null, description: null, genre: null, status: 0, memo: {} });
  assert.equal(manga.author, 'Author'); assert.equal(manga.artist, 'Artist'); assert.equal(manga.description, 'Details');
  assert.deepEqual(manga.genre, ['Adventure']); assert.equal(manga.status, 'COMPLETED');
  assert.deepEqual(manga.memo, { token: 'fixture' }); assert.equal(manga.title, 'Updated title'); assert.equal(manga.inLibrary, true);
});

test('WebUI manga/chapter/reader path persists records and binary pages locally', async () => {
  const { api, store, manager } = backend();
  const fetched = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR', page: 1 } });
  const id = fetched.mangas[0].id;
  await api.resolve('updateManga', { input: { id, patch: { inLibrary: true } } });
  const { manga, chapters } = await api.resolve('fetchMangaAndChapters', { input: { id, fetchManga: true, fetchChapters: true } });
  assert.equal(manga.author, 'Author');
  assert.deepEqual(manga.genre, ['A', 'B']);
  assert.equal(manga.status, 'COMPLETED');
  const chapterId = chapters[0].id;
  assert.equal(chapters[0].sourceOrder, 1);
  assert.equal(chapters[0].uploadDate, 1000);
  const pages = await api.resolve('fetchChapterPages', { input: { chapterId } });
  assert.equal(pages.pages.length, 1);
  assert.equal(await (await api.fetch(pages.pages[0])).text(), 'test image bytes');
  await api.resolve('updateChapter', { input: { id: chapterId, patch: { isRead: true, lastPageRead: 0 } } });
  const restored = new BrowserBackend(store, { manager });
  const library = await restored.resolve('mangas', { condition: { inLibrary: true } });
  assert.equal(library.totalCount, 1);
  assert.equal(library.nodes[0].unreadCount, 0);
  assert.equal(await (await restored.fetch(pages.pages[0])).text(), 'test image bytes');
  assert.equal((await restored.resolve('chapter', { id: chapterId })).isDownloaded, true);
  manager.call = async () => { throw new Error('network disabled for offline verification'); };
  assert.equal((await restored.resolve('fetchChapterPages', { input: { chapterId } })).pages.length, 1);
});

test('WebUI metadata writes update local records', async () => {
  const { api, store, manager } = backend();
  await api.resolve('setGlobalMetas', { input: { metas: [{ key: 'theme', value: 'dark' }] } });
  const restored = new BrowserBackend(store, { manager });
  assert.equal((await restored.resolve('meta', { key: 'theme' })).value, 'dark');
});

test('Source updates receive newest-first known chapter fields without local cache payloads or string-ID duplicates', async () => {
  const { api, manager } = backend();
  const listing = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR', page: 1 } });
  const manga = listing.mangas[0];
  await api.resolve('fetchChapters', { input: { mangaId: manga.id } });
  const first = api.db.chapters[0];
  first.memo = { token: 'first' }; first.pages = [{ localCache: 'must not send' }];
  const second = { ...first, id: api.db.nextId++, url: '/chapter/new', name: 'Two', number: 2, sourceOrder: 2, memo: { token: 'second' } };
  api.db.chapters.push(second); await api.save();
  const original = manager.call;
  let calls = 0;
  manager.call = async (id, operation, args) => {
    if (operation === 'update') {
      calls++;
      assert.deepEqual(args.knownChapters.map(chapter => chapter.url), ['/chapter/new', '/chapter/test']);
      assert.deepEqual(args.knownChapters[0].memo, { token: 'second' });
      assert.equal(args.knownChapters[0].number, 2);
      assert.ok(args.knownChapters.every(chapter => !('pages' in chapter) && !('id' in chapter)));
    }
    if (operation === 'update' && args.fetchChapters) return { manga: args.manga, chapters: args.knownChapters };
    return original(id, operation, args);
  };
  await api.resolve('fetchManga', { input: { id: String(manga.id) } });
  await api.resolve('fetchChapters', { input: { mangaId: String(manga.id) } });
  assert.equal(calls, 2); assert.equal(api.db.chapters.length, 2);
  assert.deepEqual(api.db.chapters.map(chapter => chapter.id).sort((a, b) => a - b), [first.id, second.id]);
});

test('Removed chapters leave the active catalogue but remain recoverable with their original cache and state', async () => {
  const { api, store, manager } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const [old] = await api.rememberChapters(manga, [{ url: '/old', name: 'Chapter 1', number: 1, dateUpload: 1234 }]);
  const record = api.find('chapters', old.id);
  Object.assign(record, { isRead: true, isBookmarked: true, pages: [{ url: '', imageUrl: 'https://example.test/old.png' }], isDownloaded: true, pageCount: 1, lastPageRead: 0, lastReadAt: 55 });
  const cache = { key: `webui:page:${old.id}:0`, remoteUrl: JSON.stringify(['', 'https://example.test/old.png']), blob: new Blob(['cached'], { type: 'image/png' }) };
  await store.put('settings', cache);
  await api.rememberChapters(manga, [{ url: '/different', name: 'Two', number: 2, dateUpload: 2000 }]); await api.save();
  assert.equal(api.db.chapters.length, 1); assert.equal(api.sourceChapters(manga.id)[0].url, '/different');
  assert.equal(api.manga(manga).unreadCount, 1);
  const beforeEmpty = structuredClone(api.db);
  await assert.rejects(api.rememberChapters(manga, []), /No chapters found/);
  assert.deepEqual(api.db, beforeEmpty);
  const restored = new BrowserBackend(store, { manager });
  const archive = await restored.resolve('browserArchivedChapters');
  assert.equal(archive[0].id, old.id); assert.equal(archive[0].isRead, true); assert.equal(archive[0].mangaTitle, 'Test');
  assert.equal(await (await store.get('settings', cache.key)).blob.text(), 'cached');
  assert.deepEqual(await restored.resolve('browserRestoreArchivedChapters', { input: { ids: [old.id] } }), { restored: 1 });
  assert.equal((await restored.resolve('browserArchivedChapters')).length, 0);
  const chapter = await restored.resolve('chapter', { id: old.id });
  assert.equal(chapter.isRead, true); assert.equal(chapter.isBookmarked, true); assert.equal(chapter.isDownloaded, true);
  assert.deepEqual(restored.db.chapters.map(chapter => chapter.sourceOrder).sort(), [1, 2]);
  assert.equal(await (await restored.fetch(`/browser-local/chapter/${old.id}/page/0`)).text(), 'cached');
});

test('Archive recovery rejects conflicting or duplicate selections before mutating the library', async () => {
  const { api } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const make = url => ({ url, name: url, number: 1, dateUpload: 1 });
  const [old] = await api.rememberChapters(manga, [make('/one')]);
  await api.rememberChapters(manga, [make('/two')]); await api.save();
  const snapshot = structuredClone(api.db);
  await assert.rejects(api.resolve('browserRestoreArchivedChapters', { input: { ids: [old.id, old.id] } }), /already has this URL/);
  assert.deepEqual(api.db, snapshot);
  await api.rememberChapters(api.find('mangas', manga.id), [make('/one')]); await api.save();
  const conflicting = structuredClone(api.db);
  await assert.rejects(api.resolve('browserRestoreArchivedChapters', { input: { ids: [old.id] } }), /already has this URL/);
  assert.deepEqual(api.db, conflicting);
});

test('Recognized replacement URLs migrate user state and independently copy compatible cached downloads', async () => {
  const { api, store } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const make = (url, number, scanlator = 'Group') => ({ url, name: 'Chapter ' + number, number, dateUpload: 1000, scanlator });
  const [old] = await api.rememberChapters(manga, [make('/old', 1)]);
  Object.assign(api.find('chapters', old.id), { fetchedAt: 42, isRead: true, isBookmarked: true, lastReadAt: 77, lastPageRead: 2, isDownloaded: true, pages: [{ url: '', imageUrl: 'cached' }], pageCount: 1 });
  await store.put('settings', { key: `webui:page:${old.id}:0`, remoteUrl: JSON.stringify(['', 'cached']), blob: new Blob(['original']) });
  const [replacement] = await api.rememberChapters(manga, [make('/new', 1)]);
  assert.notEqual(replacement.id, old.id); assert.equal(replacement.fetchedAt, 42);
  assert.equal(replacement.isRead, true); assert.equal(replacement.isBookmarked, true);
  assert.equal(replacement.lastReadAt, 77); assert.equal(replacement.lastPageRead, 2);
  assert.equal(replacement.isDownloaded, true);
  const newKey = `webui:page:${replacement.id}:0`;
  assert.equal(await (await store.get('settings', newKey)).blob.text(), 'original');
  await store.put('settings', { key: newKey, remoteUrl: 'different', blob: new Blob(['changed']) });
  assert.equal(await (await store.get('settings', `webui:page:${old.id}:0`)).blob.text(), 'original');
  const [newGroup] = await api.rememberChapters(manga, [make('/new-group', 1, 'Other')]);
  assert.equal(newGroup.isRead, true); assert.equal(newGroup.isBookmarked, true); assert.equal(newGroup.isDownloaded, false);
  assert.equal(newGroup.pages, undefined);
  const [unknown] = await api.rememberChapters(manga, [make('/unknown', -1)]);
  Object.assign(api.find('chapters', unknown.id), { isRead: true, isBookmarked: true, fetchedAt: 42 });
  const [unrecognized] = await api.rememberChapters(manga, [make('/unknown-new', -1)]);
  assert.equal(unrecognized.isRead, false); assert.equal(unrecognized.isBookmarked, false);
  assert.notEqual(unrecognized.fetchedAt, 42);
});

test('Missing cached blobs never produce downloaded replacements, and failed cache copy leaves catalogue intact', async () => {
  const { api, store } = backend(); await api.loading;
  const manga = api.rememberManga('fixture', { url: '/comic', title: 'Test' });
  const make = url => ({ url, name: 'One', number: 1, dateUpload: 1000 });
  const [old] = await api.rememberChapters(manga, [make('/old')]);
  Object.assign(api.find('chapters', old.id), { isRead: true, isDownloaded: true, pages: [{ url: '', imageUrl: 'cached' }], pageCount: 1 });
  const [missing] = await api.rememberChapters(manga, [make('/missing')]);
  assert.equal(missing.isDownloaded, false); assert.equal(missing.isRead, true);
  Object.assign(api.find('chapters', missing.id), { isDownloaded: true, pages: [{ url: '', imageUrl: 'cached' }], pageCount: 1 });
  await store.put('settings', { key: `webui:page:${missing.id}:0`, remoteUrl: JSON.stringify(['', 'cached']), blob: new Blob(['cached']) });
  const snapshot = structuredClone(api.db), originalPut = store.put.bind(store);
  store.put = async (name, value) => { if (value.key.startsWith('webui:page:')) throw new Error('quota exceeded'); return originalPut(name, value); };
  await assert.rejects(api.rememberChapters(manga, [make('/failed')]), /quota exceeded/);
  assert.deepEqual(api.db, snapshot);
});

test('Combined source refresh sends one flagged call and preserves policy across list refresh and cold storage', async () => {
  const { api, store, manager } = backend();
  const listing = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR', page: 1 } });
  const id = listing.mangas[0].id;
  const calls = [];
  manager.call = async (_source, operation, args) => {
    calls.push({ operation, args });
    assert.equal(operation, 'update');
    return { manga: { ...args.manga, title: 'Updated', author: 'Author', updateStrategy: 'ONLY_FETCH_ONCE', memo: { token: 'new' } }, chapters: [{ url: '/one', name: 'Chapter 1', number: 1, dateUpload: 1000, memo: { token: 'chapter' } }] };
  };
  const result = await api.resolve('fetchMangaAndChapters', { input: { id, fetchManga: true, fetchChapters: true } });
  assert.equal(calls.length, 1); assert.equal(calls[0].args.fetchDetails, true); assert.equal(calls[0].args.fetchChapters, true);
  assert.equal(result.manga.title, 'Updated'); assert.equal(result.manga.updateStrategy, 'ONLY_FETCH_ONCE'); assert.equal(result.chapters[0].chapterNumber, 1);
  const record = api.db.mangas[0];
  api.rememberManga(record.sourceId, { url: record.url, title: 'Updated', updateStrategy: 'ALWAYS_UPDATE', memo: {} });
  assert.equal(record.updateStrategy, 'ONLY_FETCH_ONCE'); await api.save();
  const cold = new BrowserBackend(store, { manager });
  assert.equal((await cold.resolve('manga', { id })).updateStrategy, 'ONLY_FETCH_ONCE');
  const before = JSON.stringify((await store.get('settings', 'webui:database')).value);
  manager.call = async () => { throw new Error('source failed'); };
  await assert.rejects(cold.resolve('fetchMangaAndChapters', { input: { id, fetchManga: true, fetchChapters: true } }), /source failed/);
  assert.equal(JSON.stringify((await store.get('settings', 'webui:database')).value), before);
  assert.equal((await cold.resolve('fetchMangaAndChapters', { input: { id, fetchManga: false, fetchChapters: false } })).chapters.length, 0);
});

test('Partial detail responses preserve nullable saved fields without hiding intentional empty values', () => {
  const { api } = backend();
  api.db = { nextId: 1, mangas: [], chapters: [], categories: [] };
  const record = api.rememberManga('fixture', { url: '/partial', title: 'Title', author: 'Author', artist: 'Artist', description: 'Saved', genre: 'A', thumbnailUrl: 'cover' });
  api.rememberManga('fixture', { url: '/partial', title: 'Title', author: null, artist: null, description: null, genre: null, thumbnailUrl: null, updateStrategy: 'ONLY_FETCH_ONCE' }, { details: true });
  assert.equal(record.author, 'Author'); assert.equal(record.artist, 'Artist'); assert.equal(record.description, 'Saved'); assert.deepEqual(record.genre, ['A']); assert.equal(record.thumbnailUrl, 'cover');
  api.rememberManga('fixture', { url: '/partial', title: 'Title', author: '', description: '', genre: '' }, { details: true });
  assert.equal(record.author, ''); assert.equal(record.description, ''); assert.deepEqual(api.manga(record).genre, []);
});

test('Removed sources are nullable; partial cached chapters and covers remain readable without source calls', async () => {
  const { api, store, manager } = backend();
  const call = manager.call;
  manager.call = async (id, operation, args) => operation === 'pages' ? [{ index: 0, url: '', imageUrl: 'https://example.test/1.png' }, { index: 1, url: '', imageUrl: 'https://example.test/2.png' }] : call(id, operation, args);
  const listing = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR' } });
  const id = listing.mangas[0].id;
  await api.resolve('fetchManga', { input: { id } });
  const { chapters } = await api.resolve('fetchChapters', { input: { mangaId: id } });
  const pages = await api.resolve('fetchChapterPages', { input: { chapterId: chapters[0].id } });
  await api.fetch(pages.pages[0]);
  await api.fetch('/browser-local/manga/' + id + '/thumbnail');
  let calls = 0;
  manager.sources = async () => [];
  manager.call = async () => { calls++; throw new Error('Source runtime must not start'); };
  const cold = new BrowserBackend(store, { manager });
  assert.equal(await (await cold.resolve('manga', { id })).source(), null);
  const cached = await cold.resolve('fetchChapterPages', { input: { chapterId: chapters[0].id } });
  assert.equal(cached.pages.length, 2); assert.equal(cached.chapter.isDownloaded, false);
  assert.equal(await (await cold.fetch(cached.pages[0])).text(), 'test image bytes');
  assert.equal(await (await cold.fetch('/browser-local/manga/' + id + '/thumbnail')).text(), 'test image bytes');
  await assert.rejects(cold.fetch(cached.pages[1]), /not cached.*not installed/);
  assert.equal(calls, 0);
});

test('Missing or mismatched cache blobs clear downloaded status instead of serving false offline success', async () => {
  const { api, store, manager } = backend();
  const listing = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR' } });
  const { chapters } = await api.resolve('fetchChapters', { input: { mangaId: listing.mangas[0].id } });
  const pages = await api.resolve('fetchChapterPages', { input: { chapterId: chapters[0].id } });
  await api.fetch(pages.pages[0]);
  assert.equal((await api.resolve('chapter', { id: chapters[0].id })).isDownloaded, true);
  await store.put('settings', { key: 'webui:page:' + chapters[0].id + ':0', remoteUrl: 'wrong manifest', blob: new Blob(['wrong image']) });
  manager.sources = async () => [];
  manager.call = async () => { throw new Error('Must not start JVM'); };
  const cold = new BrowserBackend(store, { manager });
  await assert.rejects(cold.fetch(pages.pages[0]), /not cached.*not installed/);
  assert.equal((await cold.resolve('chapter', { id: chapters[0].id })).isDownloaded, false);
  const manifest = await cold.resolve('fetchChapterPages', { input: { chapterId: chapters[0].id } });
  assert.equal(manifest.chapter.isDownloaded, false);
});

test('Raw source image URLs honor the selected transport, including an offline-test guard', async () => {
  const { store, manager } = backend();
  let attempted;
  const api = new BrowserBackend(store, { manager, transport: async request => { attempted = request.url; throw new Error('HTTP disabled'); } });
  await assert.rejects(api.fetch('https://example.test/raw-image.png'), /HTTP disabled/);
  assert.equal(attempted, 'https://example.test/raw-image.png');
});

test('Official reader batch bookmarking and progress survive reopening', async () => {
  const { api, store, manager } = backend();
  const fetched = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR', page: 1 } });
  const id = fetched.mangas[0].id;
  const { chapters } = await api.resolve('fetchChapters', { input: { mangaId: id } });
  await api.resolve('updateChapters', { input: { ids: [chapters[0].id], patch: { isBookmarked: true, isRead: true, lastPageRead: 0 } } });
  const reopened = new BrowserBackend(store, { manager });
  const chapter = await reopened.resolve('chapter', { id: chapters[0].id });
  assert.equal(chapter.isBookmarked, true);
  assert.equal(chapter.isRead, true);
  assert.ok(chapter.lastReadAt > 0);
  assert.equal((await reopened.resolve('manga', { id })).bookmarkCount, 1);
  await assert.rejects(api.resolve('updateChapters', { input: { ids: [chapter.id, -1], patch: { isBookmarked: false } } }), /does not exist/);
  assert.equal((await api.resolve('chapter', { id: chapter.id })).isBookmarked, true);
});

test('Official reader per-manga metadata persists and can be removed by key', async () => {
  const { api, store, manager } = backend();
  const fetched = await api.resolve('fetchSourceManga', { input: { source: '8061953015808280611', type: 'POPULAR', page: 1 } });
  const id = fetched.mangas[0].id;
  await api.resolve('setMangaMetas', { input: { items: [{ mangaIds: [id], metas: [{ key: 'webUI_readingMode', value: 'WEBTOON' }] }] } });
  const restored = new BrowserBackend(store, { manager });
  assert.equal((await restored.resolve('manga', { id })).meta[0].value, 'WEBTOON');
  await restored.resolve('deleteMangaMetas', { input: { items: [{ mangaIds: [id], keys: ['webUI_readingMode'] }] } });
  assert.equal((await restored.resolve('manga', { id })).meta.length, 0);
});

test('Official WebUI lazily exposes source filters and forwards nested search changes', async () => {
  const { api, manager } = backend();
  const calls = [];
  const original = manager.call;
  const filters = [{ __typename: 'GroupFilter', name: 'Genres', filters: [{ __typename: 'TriStateFilter', name: 'Adventure', default: 'IGNORE' }] }];
  manager.call = async (id, operation, args) => {
    calls.push({ id, operation, args });
    return operation === 'filters' ? filters : original(id, operation, args);
  };
  const source = await api.resolve('source', { id: '8061953015808280611' });
  assert.equal(calls.length, 0, 'Listing source metadata should not start JVM work');
  assert.deepEqual(await source.filters(), filters);
  const changes = [{ position: 0, groupChange: { position: 0, triState: 'INCLUDE' } }];
  await api.resolve('fetchSourceManga', { input: { type: 'SEARCH', source: source.id, query: 'test', page: 2, filters: changes } });
  assert.deepEqual(calls.at(-1), { id: source.id, operation: 'search', args: { page: 2, query: 'test', filters: changes } });
});

test('Unsupported WebUI operations and filters on non-search requests fail explicitly', async () => {
  const { api } = backend();
  await assert.rejects(api.resolve('updateSettings', { input: { ip: '0.0.0.0' } }), /not implemented/);
  await assert.rejects(api.resolve('fetchSourceManga', { input: { type: 'POPULAR', filters: [{ position: 0 }] } }), /require a SEARCH/);
});

test('Official source preference mutation uses the runtime and exposes refreshed controls', async () => {
  const { api, manager } = backend();
  const controls = [{ __typename: 'ListPreference', key: 'quality', title: 'Quality', entries: ['High', 'Low'], entryValues: ['hq', 'lq'], currentValue: 'lq', default: 'hq' }];
  const calls = [];
  manager.call = async (id, operation, args) => { calls.push({ id, operation, args }); return controls; };
  const change = { position: 0, listState: 'lq' };
  const result = await api.resolve('updateSourcePreference', { input: { source: '8061953015808280611', change } });
  assert.deepEqual(result.preferences, controls);
  assert.deepEqual(calls[0], { id: '8061953015808280611', operation: 'preference', args: { change } });
  assert.deepEqual(await result.source.preferences(), controls);
});
