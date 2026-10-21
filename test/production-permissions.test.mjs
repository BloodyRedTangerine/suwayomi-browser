import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceBroker } from '../src/extensions/broker.mjs';
import { createPermissionRecovery } from '../src/extensions/permission-recovery.mjs';
import { requestPermissionOrigins } from '../src/extensions/permissions.mjs';
import { repositoryUrl } from '../src/extensions/repository.mjs';
import { sourceFetch, encodeBytes } from '../src/extensions/transport.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';
import { MemoryStore } from '../src/core.mjs';
import { webuiRoot, webuiSkip } from './webui-source.mjs';

const pkg = 'fixture.permission.source';
const jarUrl = 'https://github.com/fixture/extensions/releases/download/v1/source.jar';
const catalogue = {
  name: 'Permission fixture', signingKey: 'fixture-signer',
  extensionList: { extensions: [{ name: 'Fixture', packageName: pkg, resources: { apkUrl: jarUrl.replace('.jar', '.apk'), jarUrl },
    versionCode: '1', versionName: '1', extensionLib: '1.6', contentWarning: 1,
    sources: [{ id: '123', name: 'Fixture', language: 'en', homeUrl: 'https://source.test' }] }] },
};
const ok = value => ({ status: 200, headers: [], body: encodeBytes(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))) });
const redirect = url => ({ status: 302, headers: [['location', url]], body: '' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const allowed = new Set(), prompts = [], fetched = [], listeners = new Set();
  const routes = new Map([
    ['https://repo.test/index.json', redirect('https://index-cdn.test/index.json')],
    ['https://index-cdn.test/index.json', ok(catalogue)],
    [jarUrl, redirect('https://release-assets.githubusercontent.com/fixture/source.jar')],
    ['https://release-assets.githubusercontent.com/fixture/source.jar', ok('signed-jar-fixture-boundary')],
    ['https://source.test/popular', redirect('https://browse-cdn.test/result')],
    ['https://browse-cdn.test/result', ok('listing')],
    ['https://source.test/pages', redirect('https://reader-cdn.test/pages')],
    ['https://reader-cdn.test/pages', ok('pages')],
    ['https://image-cdn.test/page.png', ok('reader image')],
    ['https://download-cdn.test/page.png', ok('download image')],
  ]);
  let broker;
  const browser = {
    permissions: {
      contains: async ({ origins }) => origins.every(origin => allowed.has(origin)),
      request: async ({ origins }) => { prompts.push([...origins]); origins.forEach(origin => allowed.add(origin)); return true; },
    },
    runtime: { id: 'production-fixture', onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: async message => {
        if (message.type === 'suwayomi:permission-required') { for (const listener of listeners) listener(message); return; }
        return new Promise(resolve => broker(message, { id: browser.runtime.id }, resolve));
      },
    },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  };
  broker = createSourceBroker(browser, async request => {
    assert.ok(allowed.has(`${new URL(request.url).origin}/*`), 'every fetched hop must have an explicit grant');
    fetched.push(request.url);
    assert.ok(routes.has(request.url), 'fixture must not contact the network');
    return structuredClone(routes.get(request.url));
  });
  const recovery = createPermissionRecovery(browser);
  return { browser, recovery, allowed, prompts, fetched, routes };
}

test('Canonical GitHub raw/blob repository URLs request and store the exact raw origin', async () => {
  for (const mode of ['raw', 'blob']) assert.equal(repositoryUrl(`https://github.com/example-owner/extensions/${mode}/repo/index.pb`),
    'https://raw.githubusercontent.com/example-owner/extensions/repo/index.pb');
  assert.equal(repositoryUrl('https://raw.githubusercontent.com/example-owner/extensions/repo/index.pb'),
    'https://raw.githubusercontent.com/example-owner/extensions/repo/index.pb');
  assert.equal(repositoryUrl(jarUrl), jarUrl);
  const requests = [];
  const backend = new BrowserBackend(new MemoryStore(), { manager: { list: async () => [] }, transport: async request => { requests.push(request.url); return ok(catalogue); } });
  await backend.resolve('addExtensionStore', { input: { indexUrl: 'https://github.com/example-owner/extensions/raw/repo/index.pb' } });
  assert.deepEqual(requests, ['https://raw.githubusercontent.com/example-owner/extensions/repo/index.pb']);
  assert.equal(backend.db.repositories[0].indexUrl, requests[0]);
});

test('Production permissions: repository redirect is withheld, emits one prompt, and grant resumes the same add', async () => {
  const f = fixture(); const prior = globalThis.chrome; globalThis.chrome = f.browser;
  try {
    f.allowed.add('https://repo.test/*');
    const api = new BrowserBackend(new MemoryStore(), { manager: { list: async () => [] }, transport: sourceFetch });
    const operation = f.recovery.run('repository:https://repo.test/index.json', () => api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } }));
    await tick();
    assert.equal(f.recovery.snapshot().length, 1);
    assert.equal(f.recovery.snapshot()[0].origin, 'https://index-cdn.test/*');
    assert.equal(f.fetched.includes('https://index-cdn.test/index.json'), false);
    await f.browser.runtime.sendMessage({ type: 'suwayomi:permission-required', origin: 'https://index-cdn.test/*' });
    assert.equal(f.recovery.snapshot().length, 1, 'duplicate denials are deduplicated by origin');
    f.recovery.granted('https://index-cdn.test/*', await requestPermissionOrigins(f.browser, ['https://index-cdn.test/*']));
    await operation;
    assert.equal(api.db.repositories.length, 1);
    assert.equal(f.recovery.snapshot().length, 0);
  } finally { f.recovery.dispose(); globalThis.chrome = prior; }
});

test('Production permissions: GitHub-release JAR install uses one prompt containing both asset origins', async () => {
  const f = fixture(); const prior = globalThis.chrome; globalThis.chrome = f.browser;
  try {
    f.allowed.add('https://index-cdn.test/*');
    let installed = false;
    const manager = { list: async () => [], install: async file => {
      assert.equal(await file.text(), 'signed-jar-fixture-boundary'); installed = true;
    } };
    const api = new BrowserBackend(new MemoryStore(), { manager, transport: sourceFetch });
    await api.resolve('addExtensionStore', { input: { indexUrl: 'https://index-cdn.test/index.json' } });
    await requestPermissionOrigins(f.browser, api.extensionPermissionOrigins(pkg));
    assert.deepEqual(f.prompts, [[
      'https://github.com/*', 'https://objects.githubusercontent.com/*',
      'https://release-assets.githubusercontent.com/*', 'https://source.test/*',
    ]]);
    await api.installFromRepository(pkg);
    assert.equal(installed, true);
    assert.equal(f.recovery.snapshot().length, 0);
  } finally { f.recovery.dispose(); globalThis.chrome = prior; }
});

test('Production permissions: an unexpected install redirect resumes the pending install after one exact-host grant', async () => {
  const f = fixture(); const prior = globalThis.chrome; globalThis.chrome = f.browser;
  try {
    f.allowed.add('https://index-cdn.test/*');
    f.routes.set('https://release-assets.githubusercontent.com/fixture/source.jar', redirect('https://unexpected-assets.test/source.jar'));
    f.routes.set('https://unexpected-assets.test/source.jar', ok('signed-jar-fixture-boundary'));
    let installs = 0;
    const api = new BrowserBackend(new MemoryStore(), { manager: { list: async () => [], install: async () => { installs++; } }, transport: sourceFetch });
    await api.resolve('addExtensionStore', { input: { indexUrl: 'https://index-cdn.test/index.json' } });
    await requestPermissionOrigins(f.browser, api.extensionPermissionOrigins(pkg));
    const operation = f.recovery.run(`install:${pkg}`, () => api.installFromRepository(pkg));
    await tick();
    assert.deepEqual(f.recovery.snapshot()[0].operations, [`install:${pkg}`]);
    assert.equal(installs, 0);
    f.recovery.granted('https://unexpected-assets.test/*', await requestPermissionOrigins(f.browser, ['https://unexpected-assets.test/*']));
    await operation;
    assert.equal(installs, 1);
    assert.deepEqual(f.prompts.at(-1), ['https://unexpected-assets.test/*']);
  } finally { f.recovery.dispose(); globalThis.chrome = prior; }
});

test('Production permissions: browse, read and download refuse unknown CDNs and succeed after a narrow grant and manual retry', async () => {
  const f = fixture(); const prior = globalThis.chrome; globalThis.chrome = f.browser;
  try {
    f.allowed.add('https://source.test/*');
    const manager = {
      list: async () => [], sources: async () => [{ id: 'fixture', name: 'Fixture', lang: 'en' }],
      call: async (_id, operation, args) => {
        if (operation === 'popular') { await sourceFetch({ url: 'https://source.test/popular' }); return { mangas: [{ title: 'Fixture', url: '/manga' }] }; }
        if (operation === 'pages') { await sourceFetch({ url: 'https://source.test/pages' }); return [{ index: 0, imageUrl: `https://${args.chapter.url === '/download' ? 'download' : 'image'}-cdn.test/page.png` }]; }
        if (operation === 'image') return { mimeType: 'image/png', body: (await sourceFetch({ url: args.pageInfo.imageUrl })).body };
        throw new Error('Unexpected fixture operation');
      },
    };
    const api = new BrowserBackend(new MemoryStore(), { manager, autoDownloads: false }); await api.loading;
    const grant = async origin => {
      assert.equal(f.recovery.snapshot().filter(p => p.origin === origin).length, 1);
      f.recovery.granted(origin, await requestPermissionOrigins(f.browser, [origin]));
    };
    const browse = () => api.resolve('fetchSourceManga', { input: { source: 'fixture', type: 'POPULAR', page: 1 } });
    await assert.rejects(browse(), /Enable source access/);
    await grant('https://browse-cdn.test/*');
    const manga = (await browse()).mangas[0];
    const chapters = await api.rememberChapters(api.find('mangas', manga.id), [
      { url: '/read', name: 'Read', number: 1, dateUpload: 0 }, { url: '/download', name: 'Download', number: 2, dateUpload: 0 },
    ]);
    const read = chapters.find(c => c.url === '/read'), download = chapters.find(c => c.url === '/download');
    await api.save();
    const pages = () => api.resolve('fetchChapterPages', { input: { chapterId: read.id } });
    await assert.rejects(pages(), /Enable source access/);
    await grant('https://reader-cdn.test/*');
    const page = (await pages()).pages[0];
    await assert.rejects(api.fetch(page), /Enable source access/);
    await grant('https://image-cdn.test/*');
    assert.equal(await (await api.fetch(page)).text(), 'reader image');
    await api.resolve('enqueueChapterDownloads', { input: { ids: [download.id] } });
    for (let i = 0; i < 4 && api.db.downloads.queue[0]?.state !== 'ERROR'; i++) await api.coordinated(() => api.downloadStep());
    assert.equal(api.db.downloads.queue[0].state, 'ERROR');
    await grant('https://download-cdn.test/*');
    await api.resolve('enqueueChapterDownloads', { input: { ids: [download.id] } });
    for (let i = 0; i < 4 && !api.find('chapters', download.id).isDownloaded; i++) await api.coordinated(() => api.downloadStep());
    assert.equal(api.find('chapters', download.id).isDownloaded, true);
    assert.equal(f.prompts.every(origins => origins.length === 1 && !origins[0].includes('://*')), true);
  } finally { f.recovery.dispose(); globalThis.chrome = prior; }
});

test('Official WebUI permission prompt renders the exact host, Allow button, and retry instruction', { skip: webuiSkip }, async () => {
  const { build } = await import('esbuild');
  const { default: Module } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const webui = webuiRoot;
  const local = fileURLToPath(new URL('../src', import.meta.url));
  const result = await build({
    stdin: { contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { BrowserPermissionPrompt } from './src/base/components/BrowserPermissionPrompt.tsx'; module.exports = renderToStaticMarkup(React.createElement(BrowserPermissionPrompt, { request: { origin: 'https://cdn.example.test/*', operations: [], granted: false, error: '' } }));`, resolveDir: webui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', alias: { '@browser-local': local }, logLevel: 'silent',
  });
  const compiled = new Module('permission-prompt-render.cjs');
  compiled._compile(result.outputFiles[0].text, 'permission-prompt-render.cjs');
  assert.match(compiled.exports, /Allow https:\/\/cdn\.example\.test\/\*/);
  assert.match(compiled.exports, /retry other source actions manually/i);
  assert.doesNotMatch(compiled.exports, /Allow \*/);
});
