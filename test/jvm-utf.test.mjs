import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeModifiedUtf8, decodeCompactString } from '../src/jvm/utf.mjs';

test('Modified UTF-8 encodes NUL and surrogate code units rather than scalar UTF-8', () => {
  assert.deepEqual([...encodeModifiedUtf8('A\0é')], [65, 0xc0, 0x80, 0xc3, 0xa9]);
  assert.deepEqual([...encodeModifiedUtf8('🔒')], [0xed, 0xa0, 0xbd, 0xed, 0xb4, 0x92]);
  assert.deepEqual([...encodeModifiedUtf8('\ud800\udfff')], [0xed, 0xa0, 0x80, 0xed, 0xbf, 0xbf]);
  assert.deepEqual([...encodeModifiedUtf8('\ud800x\udfff')], [0xed, 0xa0, 0x80, 120, 0xed, 0xbf, 0xbf]);
  assert.equal(encodeModifiedUtf8('').length, 0);
});

test('Java compact Latin-1 is not Windows-1252 and preserves every byte', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const value = decodeCompactString(bytes, 0);
  assert.equal(value.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(value.charCodeAt(i), i);
});

test('Compact UTF-16 preserves BOM, NUL, supplementary characters, lone surrogates and byte windows', () => {
  const value = '\ufeff日本語\0🔒\ud800x\udfff';
  const backing = new Uint8Array(value.length * 2 + 4);
  const view = new DataView(backing.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), true);
  assert.equal(decodeCompactString(backing.subarray(2, -2), 1), value);
  assert.throws(() => decodeCompactString(new Uint8Array(1), 1), /Odd/);
  assert.throws(() => decodeCompactString(new Uint8Array(), 2), /coder/);
});

test('Compact string conversion chunks large payloads without argument-count overflow', () => {
  const value = '\ufeffA🔒\ud800x\udfff'.repeat(15000);
  const bytes = new Uint8Array(value.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  assert.equal(decodeCompactString(bytes, 1), value);
  assert(encodeModifiedUtf8(value).length > value.length);
});
