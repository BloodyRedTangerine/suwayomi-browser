import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fetchRepository, repositoryUrl } from '../src/extensions/repository.mjs';
import { encodeBytes } from '../src/extensions/transport.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';
import { MemoryStore } from '../src/core.mjs';

const pkg = 'example.extension.test';
const entry = { name: 'Test', packageName: pkg, resources: { apkUrl: 'https://repo.test/test.apk', jarUrl: 'https://repo.test/test.jar' }, extensionLib: '1.6', versionCode: '106000', versionName: '1.6.0', contentWarning: 2,
  sources: [{ id: '9223372036854775807', name: 'Test', language: 'en', homeUrl: 'https://source.test' }] };
const catalogue = { name: 'Test repository', signingKey: 'test-key-not-a-signature', contact: { website: 'https://repo.test' }, extensionList: { extensions: [entry] } };
const json = value => new TextEncoder().encode(JSON.stringify(value));
const response = value => ({ status: 200, body: encodeBytes(value instanceof Uint8Array ? value : json(value)) });
function vi(value) { let n = BigInt.asUintN(64, BigInt(value)), b = []; do { let byte = Number(n & 127n); n >>= 7n; b.push(byte | (n ? 128 : 0)); } while (n); return b; }
const bytes = (...parts) => new Uint8Array(parts.flatMap(part => [...part]));
const field = (number, value) => typeof value === 'bigint' ? bytes(vi(number * 8), vi(value)) : bytes(vi(number * 8 + 2), vi(value.length), value);
const string = (number, value) => field(number, new TextEncoder().encode(value));
function protobuf() {
  const source = bytes(field(1, 9223372036854775807n), string(2, 'Test'), string(3, 'en'));
  const resources = bytes(string(1, entry.resources.apkUrl), string(501, entry.resources.jarUrl));
  const extension = bytes(string(1, 'Test'), string(2, pkg), field(3, resources), string(4, '1.6'), field(5, 106000n), string(6, '1.6.0'), field(7, 2n), field(8, source));
  return bytes(string(1, 'Test repository'), string(3, 'test-key-not-a-signature'), field(101, field(1, extension)), field(999, 1n));
}

test('Gzipped protobuf catalogue preserves 64-bit IDs and resource field 501', async () => {
  const repository = await fetchRepository('https://repo.test/index.pb', async () => response(gzipSync(protobuf())));
  assert.equal(repository.extensions[0].sources[0].id, '9223372036854775807');
  assert.equal(repository.extensions[0].jarUrl, entry.resources.jarUrl);
  assert.equal(repository.extensions[0].contentWarning, 'MIXED');
});
test('Repository indirection, JSON lists and legacy layouts match upstream', async () => {
  const requests = [];
  const v2 = await fetchRepository('https://repo.test/repo.json', async request => {
    requests.push(request.url); return response(request.url.endsWith('repo.json') ? { index_v2: 'index.pb' } : catalogue);
  });
  assert.equal(v2.indexUrl, 'https://repo.test/index.pb');
  assert.equal(requests.length, 2);
  const external = await fetchRepository('https://repo.test/index.json', async request => response(request.url.endsWith('list.json') ? { extensions: [entry] } : { ...catalogue, extensionList: undefined, extensionListUrl: 'list.json' }));
  assert.equal(external.extensions.length, 1);
  const legacy = await fetchRepository('https://repo.test/repo.json', async request => response(request.url.endsWith('repo.json') ? { meta: { name: 'Legacy' } } : [{ name: 'Test', pkg, apk: 'test.apk', version: '1.4.1', code: 1, nsfw: 1, sources: [{ id: '9223372036854775807', name: 'Test', lang: 'en' }] }]));
  assert.equal(legacy.extensions[0].apkUrl, 'https://repo.test/apk/test.apk');
  assert.equal(legacy.extensions[0].contentWarning, 'MIXED');
  const migrated = await fetchRepository('https://repo.test/index.min.json', async request => response(request.url.endsWith('index.min.json') ? [] : request.url.endsWith('repo.json') ? { index_v2: 'index.pb' } : catalogue));
  assert.equal(migrated.indexUrl, 'https://repo.test/index.pb');
  assert.equal(migrated.extensions[0].packageName, pkg);
});
test('Repository parser rejects unsafe URLs, cycles and malformed data without losing JSON long IDs', async () => {
  for (const url of ['file:///etc/passwd', 'https://user:secret@repo.test']) assert.throws(() => repositoryUrl(url), /HTTP/);
  await assert.rejects(fetchRepository('https://repo.test/repo.json', async () => response({ index_v2: 'repo.json' })), /cycle/);
  for (const bad of [new Uint8Array([10, 127]), new Uint8Array([8, ...Array(11).fill(255)]), new Uint8Array([0])]) await assert.rejects(fetchRepository('https://repo.test/index.pb', async () => response(bad)), /protobuf/i);
  const numericIdJson = JSON.stringify(catalogue).replace('"9223372036854775807"', '9223372036854775807');
  const exact = await fetchRepository('https://repo.test/index.json', async () => response(new TextEncoder().encode(numericIdJson)));
  assert.equal(exact.extensions[0].sources[0].id, '9223372036854775807');
  await assert.rejects(fetchRepository('https://repo.test/index.json', async () => response({ ...catalogue, extensionList: { extensions: [entry, entry] } })), /Duplicate/);
});

test('Repository entries never silently adopt manually imported extensions', async () => {
  const manager = { list: async () => [{ ...entry, version: '1.0.0', versionCode: '1', storeIndexUrl: null }], sources: async () => [] };
  const api = new BrowserBackend(new MemoryStore(), { manager, transport: async () => response(catalogue) });
  await api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  const installed = (await api.extensions())[0];
  assert.equal(installed.hasUpdate, false); assert.equal(installed.storeIndexUrl, null);
  await assert.rejects(api.installFromRepository(pkg, true), /Manual imports/);
});

test('Repository extension permission origins cover artifact redirects and source hosts', async () => {
  const api = new BrowserBackend(new MemoryStore(), { manager: { list: async () => [] }, transport: async () => response(catalogue) });
  await api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  assert.deepEqual(api.extensionPermissionOrigins(pkg), [
    'https://repo.test/*',
    'https://source.test/*',
  ]);
});

test('Catalogue refresh and repository removal are serialized', async () => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let refresh = false;
  const api = new BrowserBackend(new MemoryStore(), { manager: { list: async () => [] }, transport: async () => {
    if (refresh) { started(); await held; }
    return response(catalogue);
  } });
  await api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  refresh = true;
  const fetching = api.resolve('fetchExtensions'); await entered;
  const removing = api.resolve('removeExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  release(); await Promise.all([fetching, removing]);
  assert.equal(api.db.repositories.length, 0, 'In-flight refresh must not resurrect a removed repository');
});

test('Official repository catalogue, install, update and removal persist without erasing installed extensions', async () => {
  const store = new MemoryStore(), installed = [], actions = [];
  let remoteVersion = '106000', signingKey = catalogue.signingKey;
  const manager = { list: async () => installed, sources: async () => [],
    install: async (file, options) => { actions.push(options); assert.equal(await file.text(), 'published artifact boundary'); installed.splice(0, installed.length, { ...entry, version: '1.6.0', libraryVersion: '1.6', contentWarning: 'MIXED', versionCode: options.expectedVersion, storeIndexUrl: options.storeIndexUrl }); },
    uninstall: async id => { assert.equal(id, pkg); installed.splice(0); },
  };
  const transport = async request => response(request.url.endsWith('.jar') ? new TextEncoder().encode('published artifact boundary') : { ...catalogue, signingKey, extensionList: { extensions: [{ ...entry, versionCode: remoteVersion }] } });
  const api = new BrowserBackend(store, { manager, transport }); await api.loading;
  await api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  let extensions = (await api.resolve('extensions')).nodes;
  assert.equal(extensions[0].isInstalled, false);
  assert.equal((await extensions[0].extensionStore.extensions()).totalCount, 1);
  await api.resolve('updateExtension', { input: { id: pkg, patch: { install: true } } });
  assert.equal(actions[0].expectedPackage, pkg); assert.equal(actions[0].expectedVersion, '106000');
  assert.equal((await api.extensions())[0].isInstalled, true);
  remoteVersion = '106001'; await api.resolve('fetchExtensions');
  assert.equal((await api.extensions())[0].hasUpdate, true);
  await api.resolve('updateExtension', { input: { id: pkg, patch: { update: true } } });
  assert.equal(installed[0].versionCode, '106001');
  signingKey = ''; await assert.rejects(api.resolve('fetchExtensions'), /identity changed/);
  signingKey = 'changed'; await assert.rejects(api.resolve('fetchExtensions'), /identity changed/);
  assert.equal(api.db.repositories[0].signingKey, catalogue.signingKey);
  const reopened = new BrowserBackend(store, { manager, transport }); await reopened.loading;
  assert.equal((await reopened.resolve('extensionStores')).totalCount, 1);
  await reopened.resolve('removeExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  assert.equal(installed.length, 1); assert.equal((await reopened.extensions())[0].isObsolete, true);
  await reopened.resolve('updateExtension', { input: { id: pkg, patch: { uninstall: true } } });
  assert.equal(installed.length, 0);
});

test('Refreshing an index after install marks a missing repository package obsolete without uninstalling it', async () => {
  const installed = [];
  let published = true;
  const manager = {
    list: async () => installed,
    sources: async () => [],
    install: async (_file, options) => installed.push({
      ...entry,
      version: entry.versionName,
      libraryVersion: entry.extensionLib,
      versionCode: options.expectedVersion,
      storeIndexUrl: options.storeIndexUrl,
    }),
  };
  const transport = async request => request.url.endsWith('.jar')
    ? response(new TextEncoder().encode('fixture signed artifact boundary'))
    : response({ ...catalogue, extensionList: { extensions: published ? [entry] : [] } });
  const api = new BrowserBackend(new MemoryStore(), { manager, transport });
  await api.resolve('addExtensionStore', { input: { indexUrl: 'https://repo.test/index.json' } });
  await api.installFromRepository(pkg);
  assert.equal((await api.extensions())[0].isObsolete, false);
  assert.equal(installed.length, 1);

  published = false;
  await api.resolve('fetchExtensions');
  const rows = (await api.resolve('extensions')).nodes;
  assert.equal(rows.length, 1, 'removed catalogue entry must not erase the installed extension');
  assert.equal(rows[0].pkgName, pkg);
  assert.equal(rows[0].isInstalled, true);
  assert.equal(rows[0].isObsolete, true, 'obsolete state comes from the refreshed index');
  assert.equal(rows[0].extensionStore.indexUrl, 'https://repo.test/index.json');
});
