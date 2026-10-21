import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core.mjs';
import { BrowserBackend } from '../src/webui/backend.mjs';
import { clearBrowserDiagnosticErrors, recordBrowserDiagnosticError } from '../src/webui/diagnostics.mjs';

test('Copy diagnostics includes only scoped local facts and redacts titles, queries, cookies and headers', async () => {
  clearBrowserDiagnosticErrors();
  const store = new MemoryStore();
  const manager = { list: async () => [], sources: async () => [], runtime: { dispose() {} } };
  const backend = new BrowserBackend(store, { manager, autoDownloads: false, autoUpdates: false });
  try {
    await backend.loading;
    backend.db.mangas = [{ id: 7, title: 'PRIVATE MANGA TITLE', url: '/private-manga-title', inLibrary: true }];
    backend.db.chapters = [{ id: 9, mangaId: 7, name: 'PRIVATE CHAPTER NAME', url: '/private-chapter-name' }];
    backend.db.repositories = [{
      name: 'Trusted fixture store',
      indexUrl: 'https://repository.example/index?user=PRIVATE_QUERY',
      signingKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }];
    backend.db.downloads = { state: 'STOPPED', queue: [{ chapterId: 9, state: 'ERROR' }, { chapterId: 9, state: 'QUEUED' }] };
    await backend.save();
    await store.put('settings', {
      key: 'extension:org.example.source', packageName: 'org.example.source', version: '1.2.3', versionCode: 42,
      verification: 'verified', signerFingerprint: 'f'.repeat(64),
    });
    await store.put('settings', { key: 'webui:page:9:0', blob: new Blob(['page-bytes']) });
    await store.put('settings', {
      key: 'jvm:preferences',
      value: JSON.stringify({ source: { sessionCookie: { t: 'String', v: 'PRIVATE_COOKIE_VALUE' } } }),
      files: { version: 1, entries: [], fingerprint: '[]' },
    });
    const error = new Error('Failed PRIVATE MANGA TITLE / PRIVATE CHAPTER NAME; search PRIVATE_TYPED_QUERY; Cookie: session=PRIVATE_COOKIE_VALUE; Authorization: Bearer PRIVATE_HEADER_VALUE; https://source.example/private?token=PRIVATE_URL_QUERY');
    error.stack = `${error.name}: ${error.message}\n    at load (https://source.example/private?query=PRIVATE_STACK_QUERY:1:2)`;
    recordBrowserDiagnosticError(error, ['PRIVATE_TYPED_QUERY']);

    const diagnostics = JSON.parse(await backend.getDiagnostics());
    const serialized = JSON.stringify(diagnostics);
    for (const secret of [
      'PRIVATE MANGA TITLE', 'PRIVATE CHAPTER NAME', 'PRIVATE_TYPED_QUERY', 'PRIVATE_COOKIE_VALUE',
      'PRIVATE_HEADER_VALUE', 'PRIVATE_URL_QUERY', 'PRIVATE_STACK_QUERY', 'repository.example',
    ]) assert.equal(serialized.includes(secret), false, `Diagnostics leaked ${secret}`);
    assert.equal(diagnostics.installedExtensions[0].package, 'org.example.source');
    assert.equal(diagnostics.installedExtensions[0].verification, 'verified');
    assert.equal(diagnostics.repositories[0].name, 'Trusted fixture store');
    assert.equal(diagnostics.repositories[0].signerFingerprint, '0123456789ab');
    assert.deepEqual(diagnostics.counts, {
      mangas: 1, chapters: 1,
      downloadQueueByState: { QUEUED: 1, DOWNLOADING: 0, ERROR: 1, UNKNOWN: 0 },
    });
    assert.equal(diagnostics.storage.cachedPageCount, 1);
    assert.equal(diagnostics.storage.cachedPageBlobBytes, 10);
    assert.equal(diagnostics.recentErrors.length, 1);
    assert.match(serialized, /URL redacted/);

    for (let index = 0; index < 110; index++) recordBrowserDiagnosticError(new Error(`bounded-${index}`));
    const bounded = JSON.parse(await backend.getDiagnostics());
    assert.equal(bounded.recentErrors.length, 20);
    assert.match(bounded.recentErrors.at(-1).message, /bounded-109/);
    assert.doesNotMatch(JSON.stringify(bounded), /PRIVATE MANGA TITLE|PRIVATE_COOKIE_VALUE|PRIVATE_TYPED_QUERY/);
  } finally {
    backend.dispose();
    clearBrowserDiagnosticErrors();
  }
});
