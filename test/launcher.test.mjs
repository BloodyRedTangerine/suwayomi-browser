import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOpenWebUi, forgetWebUiTab, registerWebUiTab, shouldOpenWebUiAfterInstall } from '../src/extensions/launcher.mjs';
import { targetManifest } from '../scripts/target-manifest.mjs';

test('launcher focuses an existing WebUI tab and closes only its launcher tab', async () => {
  const calls = [];
  const store = { suwayomiBrowserWebUiTabIds: [9] };
  const api = {
    runtime: { getURL: path => `moz-extension://fixture/${path}` },
    storage: { local: {
      get: async key => ({ [key]: store[key] }),
      set: async value => Object.assign(store, value),
    } },
    tabs: {
      get: async id => { calls.push(['get', id]); return { id, windowId: 4, url: 'moz-extension://fixture/ui/index.html#/library' }; },
      update: async (...args) => calls.push(['update', ...args]),
      create: async options => { calls.push(['create', options]); return { id: 10, windowId: 4 }; },
      remove: async id => calls.push(['remove', id]),
    },
    windows: { update: async (...args) => calls.push(['focus-window', ...args]) },
  };
  const open = createOpenWebUi(api);
  const tab = await open(22);
  assert.equal(tab.id, 9);
  assert.deepEqual(calls, [
    ['get', 9],
    ['update', 9, { active: true }],
    ['focus-window', 4, { focused: true }],
    ['remove', 22],
  ]);
  assert.equal(calls.filter(([name]) => name === 'create').length, 0);
});

test('launcher creates one WebUI tab when no existing app tab is found', async () => {
  const calls = [];
  const store = {};
  const api = {
    runtime: { getURL: path => `chrome-extension://fixture/${path}` },
    storage: { local: {
      get: async key => ({ [key]: store[key] }),
      set: async value => Object.assign(store, value),
    } },
    tabs: {
      get: async id => { throw new Error('unknown tab ' + id); },
      update: async (...args) => calls.push(['update', ...args]),
      create: async options => { calls.push(['create', options]); return { id: 30 }; },
      remove: async id => calls.push(['remove', id]),
    },
    windows: { update: async (...args) => calls.push(['focus-window', ...args]) },
  };
  const open = createOpenWebUi(api);
  const [first, second] = await Promise.all([open(11), open(12)]);
  assert.equal(first.id, 30);
  assert.equal(second.id, 30);
  assert.equal(calls.filter(([name]) => name === 'create').length, 1);
  assert.deepEqual(calls.filter(([name]) => name === 'remove'), [['remove', 11], ['remove', 12]]);
  assert.deepEqual(store.suwayomiBrowserWebUiTabIds, [30]);
});

test('fresh installation opens the app but an update does not', () => {
  assert.equal(shouldOpenWebUiAfterInstall({ reason: 'install' }), true);
  assert.equal(shouldOpenWebUiAfterInstall({ reason: 'update' }), false);
  assert.equal(shouldOpenWebUiAfterInstall({ reason: 'chrome_update' }), false);
  assert.equal(shouldOpenWebUiAfterInstall(undefined), false);
});

test('Chrome and Firefox manifests open a normal-tab launcher without broad tab access', async () => {
  const source = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const target of ['chrome', 'firefox']) {
    const manifest = targetManifest(source, target);
    assert.deepEqual(manifest.options_ui, { page: 'launcher.html', open_in_tab: true });
    assert.ok(!manifest.permissions.includes('tabs'));
  }
});

test('app tabs register and close events remove only their own IDs', async () => {
  const store = {};
  const api = { storage: { local: {
    get: async key => ({ [key]: store[key] }),
    set: async value => Object.assign(store, value),
  } } };
  await registerWebUiTab(api, 7);
  await registerWebUiTab(api, 11);
  await registerWebUiTab(api, 7);
  assert.deepEqual(store.suwayomiBrowserWebUiTabIds, [7, 11]);
  await forgetWebUiTab(api, 7);
  assert.deepEqual(store.suwayomiBrowserWebUiTabIds, [11]);
});
