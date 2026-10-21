import test from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain } from '../src/extensions/public-suffix.mjs';
import { permissionPattern, permissionGrantPattern, safePermissionGrant, permissionCovers, requestPermissionOrigins } from '../src/extensions/permissions.mjs';
import { createPermissionRecovery } from '../src/extensions/permission-recovery.mjs';
import { matchingPermissionDenials } from '../src/extensions/permission-denial.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';
import { MemoryStore } from '../src/core.mjs';

test('PSL registrable domains include private, wildcard, exception and IDNA rules', () => {
  assert.equal(registrableDomain('k99.mfcdn2.xyz'), 'mfcdn2.xyz');
  assert.equal(registrableDomain('x.reader.co.uk'), 'reader.co.uk');
  assert.equal(registrableDomain('co.uk'), null);
  assert.equal(registrableDomain('x.user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('github.io'), null);
  assert.equal(registrableDomain('a.b.ck'), 'a.b.ck');
  assert.equal(registrableDomain('b.ck'), null);
  assert.equal(registrableDomain('x.www.ck'), 'www.ck');
  assert.equal(registrableDomain('www.食狮.公司.cn'), 'xn--85x722f.xn--55qx5d.cn');
  for (const host of ['127.0.0.1', '[::1]', 'localhost', 'a.localhost', 'intranet']) assert.equal(registrableDomain(host), null);
});

test('only PSL-safe domain wildcards are offered, and they cover the bare domain too', async () => {
  assert.equal(permissionPattern('https://%2A.co.uk/*'), null);
  assert.equal(registrableDomain('%2A.co.uk'), null);
  assert.equal(permissionGrantPattern('https://k99.mfcdn2.xyz/x'), 'https://*.mfcdn2.xyz/*');
  assert.equal(permissionGrantPattern('https://mfcdn2.xyz/x'), 'https://mfcdn2.xyz/*');
  assert.equal(permissionGrantPattern('https://co.uk/x'), 'https://co.uk/*');
  assert.equal(permissionGrantPattern('http://127.0.0.1:999/x'), 'http://127.0.0.1:999/*');
  assert.equal(permissionGrantPattern('http://localhost:999/x'), 'http://localhost:999/*');
  assert.equal(permissionGrantPattern('http://[::1]:999/x'), 'http://[::1]:999/*');
  for (const pattern of ['https://*.co.uk/*', 'https://*.github.io/*', '*://*/*', 'https://*/*', '<all_urls>']) {
    assert.equal(safePermissionGrant(pattern), false);
    await assert.rejects(requestPermissionOrigins({}, [pattern]), /Unsafe/);
  }
  assert.equal(permissionCovers('https://*.mfcdn2.xyz/*', 'https://mfcdn2.xyz/*'), true);
  assert.equal(permissionCovers('https://*.mfcdn2.xyz/*', 'https://nw8.mfcdn2.xyz/*'), true);
  assert.equal(permissionCovers('https://*.mfcdn2.xyz/*', 'https://notmfcdn2.xyz/*'), false);
  assert.equal(permissionCovers('https://*.mfcdn2.xyz/*', 'http://k99.mfcdn2.xyz/*'), false);
});

function fixture() {
  const listeners = new Set(), grants = new Set(), prompts = [], calls = [];
  const browser = {
    runtime: { id: 'test', onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    permissions: {
      contains: async ({ origins }) => origins.every(origin => [...grants].some(pattern => permissionCovers(pattern, origin))),
      request: async ({ origins }) => { prompts.push(origins); origins.forEach(pattern => grants.add(pattern)); return true; },
    },
  };
  const recovery = createPermissionRecovery(browser, { batchWindowMs: 10 });
  const denial = url => Object.assign(new Error('Enable source access in the extension before contacting ' + new URL(url).hostname), { deniedOrigin: new URL(url).origin + '/*' });
  const pages = ['https://k99.mfcdn2.xyz/1.png', 'https://nw8.mfcdn3.xyz/2.png', 'https://l1n.mfcdn1.xyz/3.png'].map((imageUrl, index) => ({ imageUrl, index }));
  const manager = { list: async () => [], sources: async () => [{ id: 'fixture', name: 'Fixture', lang: 'en' }], call: async (_id, operation, args) => {
    if (operation === 'popular') return { mangas: [{ title: 'Synthetic', url: '/fixture' }] };
    if (operation === 'pages') return pages;
    if (operation === 'image') {
      calls.push(args.pageInfo.imageUrl);
      if (!await browser.permissions.contains({ origins: [new URL(args.pageInfo.imageUrl).origin + '/*'] })) throw denial(args.pageInfo.imageUrl);
      return { mimeType: 'image/png', body: btoa('fixture image') };
    }
    throw new Error('Unexpected synthetic operation');
  } };
  return { browser, recovery, grants, prompts, calls, manager, denial, pages, listeners };
}

test('several denied hosts form ONE prompt and ONE browser permission request', async () => {
  const f = fixture();
  try {
    for (const origin of ['https://k99.mfcdn2.xyz/*', 'https://l1n.mfcdn2.xyz/*', 'https://nw8.mfcdn3.xyz/*'])
      for (const listener of f.listeners) listener({ type: 'suwayomi:permission-required', origin });
    assert.equal(f.recovery.snapshot().length, 1);
    assert.equal(f.recovery.snapshot()[0].ready, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    const [request] = f.recovery.snapshot();
    assert.equal(request.ready, true);
    assert.deepEqual(request.origins, ['https://*.mfcdn2.xyz/*', 'https://*.mfcdn3.xyz/*']);
    await f.recovery.granted(request.origins, await requestPermissionOrigins(f.browser, request.origins));
    assert.equal(f.prompts.length, 1);
  } finally { f.recovery.dispose(); }
});

async function backend(f) {
  const api = new BrowserBackend(new MemoryStore(), { manager: f.manager, permissionRecovery: f.recovery, autoDownloads: false, autoUpdates: false });
  await api.loading;
  const manga = (await api.resolve('fetchSourceManga', { input: { source: 'fixture', type: 'POPULAR', page: 1 } })).mangas[0];
  const [chapter] = await api.rememberChapters(api.find('mangas', manga.id), [{ url: '/chapter', name: 'Synthetic', number: 1, dateUpload: 0 }]);
  await api.save();
  return { api, chapter };
}

test('reader page retries after the grant without reload; chapter manifest batches all known CDN domains', async () => {
  const f = fixture(), previous = globalThis.chrome; globalThis.chrome = f.browser;
  const { api, chapter } = await backend(f);
  try {
    const pages = await api.resolve('fetchChapterPages', { input: { chapterId: chapter.id } });
    assert.deepEqual(f.recovery.snapshot()[0].origins, ['https://*.mfcdn1.xyz/*', 'https://*.mfcdn2.xyz/*', 'https://*.mfcdn3.xyz/*']);
    const response = api.fetch(pages.pages[0]);
    while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const request = f.recovery.snapshot()[0];
    await f.recovery.granted(request.origins, await requestPermissionOrigins(f.browser, request.origins));
    assert.equal(await (await response).text(), 'fixture image');
    assert.equal(f.calls.length, 2, 'only denied page is re-requested');
    assert.equal(f.prompts.length, 1);
    await api.fetch(pages.pages[1]); await api.fetch(pages.pages[2]);
    assert.equal(f.recovery.snapshot().filter(item => !item.granted).length, 0);
  } finally { api.dispose(); f.recovery.dispose(); globalThis.chrome = previous; }
});

test('grant resumes only permission-denied download rows; non-permission errors remain manual', async () => {
  const f = fixture(), { api, chapter } = await backend(f);
  try {
    await api.resolve('enqueueChapterDownloads', { input: { ids: [chapter.id] } });
    for (let i = 0; i < 4 && api.db.downloads.queue[0]?.state !== 'ERROR'; i++) await api.coordinated(() => api.downloadStep());
    const row = api.db.downloads.queue[0];
    assert.equal(row.state, 'ERROR');
    assert.deepEqual(row.deniedOrigins, ['https://k99.mfcdn2.xyz/*']);
    const other = { chapterId: 9999, state: 'ERROR', error: 'HTTP 500', deniedOrigins: [], tries: 1 };
    api.db.downloads.queue.push(other); await api.save();
    f.grants.add('https://*.mfcdn1.xyz/*'); f.grants.add('https://*.mfcdn3.xyz/*');
    const pattern = 'https://*.mfcdn2.xyz/*';
    await f.recovery.granted([pattern], await requestPermissionOrigins(f.browser, [pattern]));
    assert.equal(api.db.downloads.queue.find(item => item.chapterId === chapter.id).state, 'QUEUED');
    for (let i = 0; i < 8 && !api.find('chapters', chapter.id).isDownloaded; i++) await api.coordinated(() => api.downloadStep());
    assert.equal(api.find('chapters', chapter.id).isDownloaded, true);
    assert.equal(api.db.downloads.queue.find(item => item.chapterId === 9999).state, 'ERROR');
    assert.equal(api.db.downloads.queue.find(item => item.chapterId === 9999).tries, 1);
  } finally { api.dispose(); f.recovery.dispose(); }
});

test('permission metadata requires a matching active broker denial, never arbitrary error text', () => {
  const record = { message: 'Enable source access before contacting cdn.test', deniedOrigins: ['https://cdn.test/*'] };
  assert.deepEqual(matchingPermissionDenials('IOException: ' + record.message, [record]), ['https://cdn.test/*']);
  assert.deepEqual(matchingPermissionDenials('HTTP 500', [record]), []);
  assert.deepEqual(matchingPermissionDenials(record.message, []), []);
});

test('an actual non-permission download failure never resumes after a domain grant', async () => {
  const f = fixture(), { api, chapter } = await backend(f);
  try {
    let failedCalls = 0;
    const original = f.manager.call;
    f.manager.call = async (id, operation, args) => {
      if (operation === 'image') { failedCalls++; throw new Error('HTTP 500'); }
      return original(id, operation, args);
    };
    await api.resolve('enqueueChapterDownloads', { input: { ids: [chapter.id] } });
    for (let i = 0; i < 4 && api.db.downloads.queue[0]?.state !== 'ERROR'; i++) await api.coordinated(() => api.downloadStep());
    assert.equal(failedCalls, 1); assert.deepEqual(api.db.downloads.queue[0].deniedOrigins, []);
    api.autoDownloads = true;
    const pattern = 'https://*.mfcdn2.xyz/*';
    await f.recovery.granted([pattern], await requestPermissionOrigins(f.browser, [pattern]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failedCalls, 1); assert.equal(api.db.downloads.queue[0].state, 'ERROR');
  } finally { api.dispose(); f.recovery.dispose(); }
});

test('aborting a pending reader image cancels its permission waiter, without retry', async () => {
  const f = fixture(); const controller = new AbortController(); let calls = 0;
  const pending = f.recovery.run('reader:abort', async () => { calls++; throw f.denial('https://k99.mfcdn2.xyz/1'); }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
  f.recovery.dispose();
});

test('restore then install then grant loads thumbnail and expired chapter without reload', async () => {
  const f = fixture(), previous = globalThis.chrome; globalThis.chrome = f.browser;
  let installed = false, coverCalls = 0, staleCalls = 0, pageLists = 0;
  const original = f.manager.call;
  f.manager.sources = async () => installed ? [{ id: 'fixture', name: 'Fixture', lang: 'en' }] : [];
  f.manager.call = async (id, operation, args) => {
    if (operation === 'thumbnail') {
      coverCalls++;
      if (!await f.browser.permissions.contains({ origins: ['https://k99.mfcdn2.xyz/*'] })) throw f.denial('https://k99.mfcdn2.xyz/cover');
      return { mimeType: 'image/png', body: btoa('restored cover') };
    }
    if (operation === 'pages') { pageLists++; return [{ url: '', imageUrl: 'https://new.mfcdn2.xyz/fresh.png' }]; }
    if (operation === 'image' && args.pageInfo.imageUrl.includes('expired')) { staleCalls++; throw Object.assign(new Error('HTTP error 410'), { status: 410 }); }
    return original(id, operation, args);
  };
  const api = new BrowserBackend(new MemoryStore(), { manager: f.manager, permissionRecovery: f.recovery, autoDownloads: false, autoUpdates: false });
  try {
    await api.loading;
    const backup = new Blob([JSON.stringify({ format: 'suwayomi-browser-backup', version: 1,
      mangas: [{ id: 10, sourceId: 'fixture', url: '/restored', title: 'Synthetic restored', inLibrary: true, categoryIds: [0], thumbnailUrl: 'https://k99.mfcdn2.xyz/cover' }],
      chapters: [{ id: 11, mangaId: 10, url: '/chapter', name: 'Synthetic chapter', number: 1, dateUpload: 0, isRead: true, lastPageRead: 0, pageCount: 1, pages: [{ url: '', imageUrl: 'https://old.mfcdn2.xyz/expired.png' }] }], sources: [{ id: 'fixture' }],
    })]);
    assert.equal((await api.validateBrowserBackup(backup)).missingSources.length, 1);
    await api.resolve('restoreBackup', { input: { backup } });
    installed = true;
    const cover = api.fetch('/browser-local/manga/10/thumbnail');
    // Capture a rejection immediately so the pre-fix failure is an assertion,
    // not an unhandled rejection while the fixture waits for its prompt.
    const result = cover.then(response => ({ response }), error => ({ error }));
    for (let i = 0; i < 10 && !f.recovery.snapshot().some(row => row.operations?.length); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.recovery.snapshot().some(row => row.operations?.length), 'thumbnail must wait in permission recovery');
    const pattern = 'https://*.mfcdn2.xyz/*';
    await f.recovery.granted([pattern], await requestPermissionOrigins(f.browser, [pattern]));
    const recovered = await result; if (recovered.error) throw recovered.error;
    assert.equal(await recovered.response.text(), 'restored cover');
    assert.equal(coverCalls, 2);
    assert.equal(await (await api.fetch('/browser-local/chapter/11/page/0')).text(), 'fixture image');
    assert.equal(staleCalls, 0, 'restored manifests are refreshed before using expired addresses'); assert.equal(pageLists, 1);
    assert.equal(api.find('chapters', 11).isRead, true);
  } finally { api.dispose(); f.recovery.dispose(); globalThis.chrome = previous; }
});

test('expired image repair does not retry non-permission HTTP500 or timeout failures', async () => {
  for (const error of [new Error('HTTP error 500'), new DOMException('Source timed out', 'TimeoutError')]) {
    const f = fixture(), { api, chapter } = await backend(f); let images = 0, refreshes = 0;
    try {
      await api.resolve('fetchChapterPages', { input: { chapterId: chapter.id } });
      f.manager.call = async (_id, operation) => { if (operation === 'image') { images++; throw error; } if (operation === 'pages') { refreshes++; return f.pages; } throw new Error('Unexpected call'); };
      await assert.rejects(api.fetch(`/browser-local/chapter/${chapter.id}/page/0`), error);
      assert.equal(images, 1); assert.equal(refreshes, 0);
    } finally { api.dispose(); f.recovery.dispose(); }
  }
});

test('an existing expired page address is refreshed once without losing reader state', async () => {
  const f = fixture(), { api, chapter } = await backend(f); let images = 0, refreshes = 0;
  try {
    await api.resolve('fetchChapterPages', { input: { chapterId: chapter.id } });
    f.manager.call = async (_id, operation, args) => {
      if (operation === 'pages') { refreshes++; return [{ url: '', imageUrl: 'https://new.mfcdn2.xyz/fresh.png' }]; }
      if (operation === 'image') { images++; if (args.pageInfo.imageUrl !== 'https://new.mfcdn2.xyz/fresh.png') throw new Error('HTTP error 410'); return { mimeType: 'image/png', body: btoa('fresh') }; }
      throw new Error('Unexpected source operation');
    };
    assert.equal(await (await api.fetch(`/browser-local/chapter/${chapter.id}/page/0`)).text(), 'fresh');
    assert.equal(images, 2); assert.equal(refreshes, 1);
  } finally { api.dispose(); f.recovery.dispose(); }
});
