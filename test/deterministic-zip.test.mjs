import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createZip } from '../scripts/deterministic-zip.mjs';

const entries = () => [
  { name: 'z/last.bin', data: Buffer.from(Array.from({ length: 4000 }, (_, index) => index % 7)) },
  { name: 'a/first.txt', data: Buffer.from('hello hello hello hello hello hello') },
  { name: 'manifest.json', data: Buffer.from('{"name":"x"}') },
  { name: 'ünïcode/ñame.txt', data: Buffer.from('unicode names use the UTF-8 flag') },
];

test('archives are independent of input order and round-trip through a standard reader', () => {
  const first = createZip(entries(), { epochSeconds: 1792540800 });
  const second = createZip(entries().reverse(), { epochSeconds: 1792540800 });
  assert.equal(Buffer.compare(first, second), 0);
  const files = unzipSync(first);
  assert.deepEqual(Object.keys(files), ['a/first.txt', 'manifest.json', 'z/last.bin', 'ünïcode/ñame.txt']);
  assert.equal(Buffer.from(files['a/first.txt']).toString(), 'hello hello hello hello hello hello');
});

test('timestamps come from the declared epoch in UTC, never from the clock or the time zone', () => {
  const archive = createZip([{ name: 'manifest.json', data: Buffer.from('{}') }], { epochSeconds: 1792540800 });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const time = view.getUint16(10, true);
  const day = view.getUint16(12, true);
  assert.equal(((day >> 9) + 1980) + '-' + ((day >> 5) & 15) + '-' + (day & 31), '2026-10-21');
  assert.equal(time, 0);
  const other = createZip([{ name: 'manifest.json', data: Buffer.from('{}') }], { epochSeconds: 1792540800 + 3600 });
  assert.notEqual(Buffer.compare(archive, other), 0);
  assert.throws(() => createZip([{ name: 'a', data: Buffer.alloc(1) }, { name: 'a', data: Buffer.alloc(1) }], { epochSeconds: 1792540800 }), /Duplicate/);
});
