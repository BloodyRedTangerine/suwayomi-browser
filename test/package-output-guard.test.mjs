import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoPrivateKeyMaterial } from '../scripts/package-output-guard.mjs';

test('package output guard accepts ordinary files and rejects key files or PEM private-key content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suwayomi-package-guard-'));
  try {
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'manifest.json'), '{"name":"test"}');
    await writeFile(join(directory, 'nested', 'private.pem'), 'not printed');
    await assert.rejects(assertNoPrivateKeyMaterial(directory), /nested\/private\.pem/);
    await rm(join(directory, 'nested', 'private.pem'));
    const privateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await writeFile(join(directory, 'nested', 'config.txt'), `${privateKeyMarker}\nredacted fixture\n`);
    await assert.rejects(assertNoPrivateKeyMaterial(directory), /nested\/config\.txt/);
    await rm(join(directory, 'nested', 'config.txt'));
    await assert.doesNotReject(assertNoPrivateKeyMaterial(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
