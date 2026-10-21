import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MemoryStore } from '../src/core.mjs';
import { ExtensionManager } from '../src/extensions/manager.mjs';
import { createSyntheticApk, createSyntheticJar } from './synthetic-apk.mjs';

globalThis.crypto ||= webcrypto;

const synthetic = createSyntheticApk({ signer: 'repository' });
const signer = synthetic.fingerprint;
const otherSigner = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const archive = synthetic.bytes;
const jarArchive = createSyntheticJar();
const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.extension" android:versionName="1.0" android:versionCode="7"><uses-feature android:name="tachiyomi.extension"/><application android:label="Fixture"><meta-data android:name="tachiyomi.extension.class" android:value="example.Extension"/><meta-data android:name="tachiyomix.extensionLib" android:value="1.6"/><meta-data android:name="tachiyomix.name" android:value="Test Extension"/></application></manifest>`;

function node(attributes = {}) {
  return {
    getAttribute: name => attributes[name] ?? null,
    getAttributeNS: (_namespace, name) => attributes[`android:${name}`] ?? null,
  };
}

class FixtureDomParser {
  parseFromString() {
    const root = node({ package: 'com.example.extension', 'android:versionName': '1.0', 'android:versionCode': '7' });
    const application = node({ 'android:label': 'Fixture' });
    const feature = node({ 'android:name': 'tachiyomi.extension' });
    const metadata = [
      node({ 'android:name': 'tachiyomi.extension.class', 'android:value': 'example.Extension' }),
      node({ 'android:name': 'tachiyomix.extensionLib', 'android:value': '1.6' }),
      node({ 'android:name': 'tachiyomix.name', 'android:value': 'Test Extension' }),
    ];
    return {
      documentElement: root,
      querySelector: selector => selector === 'parsererror' ? null : selector === 'application' ? application : selector === 'uses-feature' ? feature : null,
      querySelectorAll: selector => selector === 'application > meta-data' ? metadata : selector === 'uses-feature' ? [feature] : [],
    };
  }
}

function makeRuntime(events) {
  return {
    closed: false,
    async manifest() { events.push('manifest'); return manifest; },
    async verifyJarSignature() { events.push('verify-jar'); return `jar-v1:${signer}`; },
    async install(bytes, classes, format) {
      events.push(`execute:${format}`);
      if (format === 'apk') assert.deepEqual(classes, ['example.Extension']);
      return { sources: [{ id: 'fixture-source', name: 'Fixture' }], jar: bytes.slice() };
    },
    async request(operation) {
      assert.equal(operation, 'state');
      return { preferences: '{}', files: { version: 1, entries: [], fingerprint: '[]' } };
    },
    dispose() { this.closed = true; },
  };
}

function managerWithRuntime(store, events, options = {}) {
  const previousWorker = globalThis.Worker;
  const previousDomParser = globalThis.DOMParser;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  globalThis.DOMParser = FixtureDomParser;
  const manager = new ExtensionManager(store, options);
  manager.runtime.dispose();
  manager.runtime = makeRuntime(events);
  manager.resetRuntime = function resetRuntime() {
    this.runtime.dispose();
    this.runtime = makeRuntime(events);
    this.loaded.clear();
    this.restored = false;
  };
  return { manager, restoreWorker: () => {
    globalThis.Worker = previousWorker;
    if (previousDomParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previousDomParser;
  } };
}

async function installFromRepository(manager, extra = {}) {
  return manager.install(new Blob([archive], { type: 'application/vnd.android.package-archive' }), {
    expectedPackage: 'com.example.extension',
    expectedVersion: '7',
    storeIndexUrl: 'https://repo.example/index.pb',
    repositoryName: 'Fixture repository',
    repositoryFingerprint: signer,
    manualImport: false,
    ...extra,
  });
}

function classesDexOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1);
  let cursor = view.getUint32(eocd + 16, true);
  for (let index = 0; index < view.getUint16(eocd + 10, true); index++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === 'classes.dex') {
      const local = view.getUint32(cursor + 42, true);
      return local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('APK fixture has no classes.dex entry');
}

test('repository-pinned APK is cryptographically verified before execution and saved with its original bytes', async () => {
  const events = [], confirmations = [], store = new MemoryStore();
  const { manager, restoreWorker } = managerWithRuntime(store, events, { confirmSigner: (...args) => { confirmations.push(args); return true; } });
  try {
    const record = await installFromRepository(manager);
    assert.deepEqual(confirmations, [], 'a matching repository signer needs no extra prompt');
    assert.deepEqual(events.filter(event => event.startsWith('execute:')), ['execute:apk']);
    assert.equal(record.verification, 'verified');
    assert.equal(record.signatureScheme, 'apk-v2');
    assert.equal(record.signerFingerprint, signer);
    assert.equal(record.archiveFormat, 'apk');
    assert.deepEqual(new Uint8Array(await record.archive.arrayBuffer()), archive);
  } finally { manager.runtime.dispose(); restoreWorker(); }
});

test('repository mismatch and changed installed signer are refused before extension code runs', async () => {
  const events = [], store = new MemoryStore();
  const { manager, restoreWorker } = managerWithRuntime(store, events);
  try {
    await assert.rejects(installFromRepository(manager, { repositoryFingerprint: otherSigner }), /does not match repository signing key/);
    assert.equal(events.some(event => event.startsWith('execute:')), false);
    await store.put('settings', {
      key: 'extension:com.example.extension', packageName: 'com.example.extension', versionCode: '6',
      signerFingerprint: otherSigner, verification: 'verified', revision: 'existing', jar: new Blob(['prior']),
    });
    await assert.rejects(installFromRepository(manager), /signer fingerprint changed/);
    assert.equal(events.some(event => event.startsWith('execute:')), false);
  } finally { manager.runtime.dispose(); restoreWorker(); }
});

test('manual imports require explicit confirmation and pin the confirmed signer', async () => {
  const deniedEvents = [], deniedStore = new MemoryStore(), prompts = [];
  const denied = managerWithRuntime(deniedStore, deniedEvents, {
    confirmSigner: async (message, context) => { prompts.push({ message, context }); return false; },
  });
  try {
    await assert.rejects(denied.manager.install(new Blob([archive])), /confirmation was declined/);
    assert.equal(deniedEvents.some(event => event.startsWith('execute:')), false);
    assert.match(prompts[0].message, new RegExp(signer));
    assert.equal(prompts[0].context.manualImport, true);
  } finally { denied.manager.runtime.dispose(); denied.restoreWorker(); }

  const acceptedEvents = [], acceptedStore = new MemoryStore();
  const accepted = managerWithRuntime(acceptedStore, acceptedEvents, { confirmSigner: async () => true });
  try {
    const record = await accepted.manager.install(new Blob([archive]));
    assert.equal(record.signerFingerprint, signer);
    assert.equal(record.verification, 'verified');
    assert.deepEqual(acceptedEvents.filter(event => event.startsWith('execute:')), ['execute:apk']);
  } finally { accepted.manager.runtime.dispose(); accepted.restoreWorker(); }
});

test('unfingerprinted repositories require first-use confirmation, then pin that signer', async () => {
  const events = [], prompts = [], store = new MemoryStore();
  const { manager, restoreWorker } = managerWithRuntime(store, events, {
    confirmSigner: async (message, context) => { prompts.push({ message, context }); return true; },
  });
  try {
    const options = {
      expectedPackage: 'com.example.extension', expectedVersion: '7', storeIndexUrl: 'https://repo.example/index.pb',
      repositoryName: 'Unfingerprinted repository', repositoryFingerprint: '', manualImport: false,
    };
    await manager.install(new Blob([archive]), options);
    await manager.install(new Blob([archive]), options);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].message, /does not publish a signing fingerprint/);
    assert.equal(prompts[0].context.manualImport, false);
    assert.deepEqual(events.filter(event => event.startsWith('execute:')), ['execute:apk', 'execute:apk']);
  } finally { manager.runtime.dispose(); restoreWorker(); }
});

test('signed JAR import uses the JVM verifier before execution', async () => {
  const events = [], store = new MemoryStore();
  const { manager, restoreWorker } = managerWithRuntime(store, events, { confirmSigner: async () => true });
  try {
    const record = await manager.install(new Blob([jarArchive], { type: 'application/java-archive' }));
    assert.equal(record.signatureScheme, 'jar-v1');
    assert.equal(record.signerFingerprint, signer);
    assert.ok(events.indexOf('verify-jar') >= 0 && events.indexOf('verify-jar') < events.indexOf('execute:jar'));
  } finally { manager.runtime.dispose(); restoreWorker(); }
});

test('cold startup re-verifies trusted archives, while legacy records remain marked and usable', async () => {
  const events = [], store = new MemoryStore();
  await store.put('settings', {
    key: 'extension:com.example.extension', packageName: 'com.example.extension', versionCode: '7',
    classes: ['stale.Class'], sources: [], contentWarning: 'SAFE', signatureScheme: 'apk-v2',
    signerFingerprint: signer, verifiedAt: new Date().toISOString(), verification: 'verified',
    archive: new Blob([archive]), archiveFormat: 'apk', jar: new Blob(['derived']),
  });
  await store.put('settings', {
    key: 'extension:legacy.extension', packageName: 'legacy.extension', versionCode: '1',
    classes: ['Legacy.Source'], sources: [], contentWarning: 'SAFE', jar: new Blob(['legacy-bytecode']),
  });
  const { manager, restoreWorker } = managerWithRuntime(store, events);
  try {
    await manager.ready();
    const verified = await store.get('settings', 'extension:com.example.extension');
    const legacy = await store.get('settings', 'extension:legacy.extension');
    assert.equal(verified.sources[0].id, 'fixture-source');
    assert.equal(legacy.verification, 'pre-0.3.0');
    assert.deepEqual(events.filter(event => event.startsWith('execute:')), ['execute:apk', 'execute:jar']);
  } finally { manager.runtime.dispose(); restoreWorker(); }
});

test('cold startup refuses a tampered retained APK before source construction', async () => {
  const tampered = archive.slice();
  tampered[classesDexOffset(tampered) + 8] ^= 1;
  const events = [], store = new MemoryStore();
  await store.put('settings', {
    key: 'extension:com.example.extension', packageName: 'com.example.extension', versionCode: '7',
    classes: ['stale.Class'], sources: [], contentWarning: 'SAFE', signatureScheme: 'apk-v2',
    signerFingerprint: signer, verifiedAt: new Date().toISOString(), verification: 'verified',
    archive: new Blob([tampered]), archiveFormat: 'apk', jar: new Blob(['derived']),
  });
  const { manager, restoreWorker } = managerWithRuntime(store, events);
  try {
    await assert.rejects(manager.ready(), /content digest does not match/);
    assert.equal(events.some(event => event.startsWith('execute:')), false);
  } finally { manager.runtime.dispose(); restoreWorker(); }
});
