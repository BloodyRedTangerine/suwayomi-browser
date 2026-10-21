import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFilesystem, restoreFilesystem, validateFilesystem, FILESYSTEM_LIMITS } from '../src/extensions/filesystem.mjs';

function mockFS() {
  const entries = new Map([['/data', { type: 'dir', mode: 0o755, mtime: 123 }], ['/cache', { type: 'dir', mode: 0o755, mtime: 123 }]]);
  return {
    entries,
    readdir(path) { return ['.', '..', ...[...entries.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(key => key.slice(path.length + 1))]; },
    lstat(path) { const item = entries.get(path); if (!item) throw Error('Missing entry'); return { mode: (item.type === 'dir' ? 0o040000 : item.type === 'link' ? 0o120000 : 0o100000) | item.mode, mtime: item.mtime, size: item.bytes?.length || 0 }; },
    readFile(path) { return entries.get(path).bytes.slice(); },
    writeFile(path, bytes) { entries.set(path, { type: 'file', bytes: bytes.slice(), mode: 0o644, mtime: 999 }); },
    mkdir(path) { entries.set(path, { type: 'dir', mode: 0o755, mtime: 999 }); },
    chmod(path, mode) { entries.get(path).mode = mode; },
    utime(path, _atime, mtime) { entries.get(path).mtime = mtime / 1000; },
  };
}
const entry = (path, type = 'file') => ({ path, type, mode: 0o600, mtime: 123, ...(type === 'file' ? { bytes: new Uint8Array([0, 128, 255]) } : {}) });

test('JVM filesystem checkpoints preserve binary bytes, empty directories, permissions and timestamps, excluding cache', async () => {
  const a = mockFS(); a.mkdir('/data/empty'); a.mkdir('/data/nested'); a.writeFile('/data/nested/二.bin', new Uint8Array([0, 128, 255]));
  a.chmod('/data/nested/二.bin', 0o640); a.utime('/data/nested/二.bin', 123000, 123000);
  a.writeFile('/cache/disposable', new Uint8Array([1]));
  const snapshot = await captureFilesystem(a), b = mockFS();
  restoreFilesystem(b, structuredClone(snapshot));
  assert.deepEqual(await captureFilesystem(b), snapshot);
  assert.equal(b.entries.has('/cache/disposable'), false);
  b.entries.delete('/data/nested/二.bin');
  assert.notEqual((await captureFilesystem(b)).fingerprint, snapshot.fingerprint);
  a.writeFile('/data/nested/二.bin', new Uint8Array([3, 2, 1]));
  assert.notEqual((await captureFilesystem(a)).fingerprint, snapshot.fingerprint);
});

test('Malformed JVM snapshots reject traversal, duplicate paths, missing parents and bad bytes before writing', () => {
  for (const entries of [[entry('/extensions/host.jar')], [entry('/data/../host')], [entry('/data//file')], [entry('/data/a'), entry('/data/a')], [entry('/data/missing/file')], [{ ...entry('/data/file'), bytes: 'not bytes' }], [{ ...entry('/data/file'), mode: 0o7777 }], [{ ...entry('/data/file'), mtime: NaN }]]) {
    const fs = mockFS(), before = structuredClone(fs.entries);
    assert.throws(() => restoreFilesystem(fs, { version: 1, entries })); assert.deepEqual(fs.entries, before);
  }
  const fs = mockFS(); fs.writeFile('/data/existing', new Uint8Array([1]));
  assert.throws(() => restoreFilesystem(fs, { version: 1, entries: [entry('/data/new')] }), /fresh filesystem/);
});

test('Filesystem checkpoint bounds and unsupported symlinks fail explicitly', async () => {
  assert.throws(() => validateFilesystem({ version: 1, entries: [{ ...entry('/data/large'), bytes: new Uint8Array(FILESYSTEM_LIMITS.bytes + 1) }] }), /32 MiB/);
  assert.throws(() => validateFilesystem({ version: 1, entries: Array.from({ length: FILESYSTEM_LIMITS.entries + 1 }, (_, i) => entry('/data/' + i)) }));
  const fs = mockFS(); fs.entries.set('/data/link', { type: 'link', mode: 0o777, mtime: 1 });
  await assert.rejects(captureFilesystem(fs), /no symlinks/);
});
