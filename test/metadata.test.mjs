import test from 'node:test';
import assert from 'node:assert/strict';
import { contentWarningFromMetadata } from '../src/extensions/metadata.mjs';

test('Extension content ratings match Suwayomi enums and legacy/binary manifest values', () => {
  assert.equal(contentWarningFromMetadata({}), 'SAFE');
  assert.equal(contentWarningFromMetadata({ 'tachiyomi.extension.nsfw': '1' }), 'MIXED');
  assert.equal(contentWarningFromMetadata({ 'tachiyomix.contentWarning': '2' }), 'NSFW');
  assert.equal(contentWarningFromMetadata({ 'tachiyomix.contentWarning': '{16:2}' }), 'NSFW');
  assert.equal(contentWarningFromMetadata({ 'tachiyomix.contentWarning': '0', 'tachiyomi.extension.nsfw': '1' }), 'MIXED');
  assert.equal(contentWarningFromMetadata({ 'tachiyomix.contentWarning': '3' }), 'MIXED');
});
