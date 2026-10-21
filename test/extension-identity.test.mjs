import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const expectedId = 'jcjicocbfnajldjccnfnglphngckjkfn';

test('manifest pins the single stable public key and its deterministic Chromium extension ID', () => {
  assert.equal(typeof manifest.key, 'string');
  const publicKey = Buffer.from(manifest.key, 'base64');
  assert.equal(publicKey.toString('base64'), manifest.key, 'manifest key must be canonical base64');
  const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  const actualId = hex.replace(/[0-9a-f]/g, digit => 'abcdefghijklmnop'[Number.parseInt(digit, 16)]);
  assert.equal(actualId, expectedId);
});
