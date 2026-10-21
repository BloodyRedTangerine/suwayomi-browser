import test from 'node:test';
import assert from 'node:assert/strict';
import { addMissingClientHintHeaders, defaultUserAgentClientHints } from '../src/extensions/user-agent-hints.mjs';

test('default client hints use only browser-provided low-entropy Chromium values', () => {
  const hints = defaultUserAgentClientHints({
    brands: [{ brand: 'Chromium', version: '133' }, { brand: ' Not;A Brand', version: '99' }],
    mobile: false,
    platform: 'Linux',
    architecture: 'x86',
    platformVersion: '6.8.0',
  });
  assert.deepEqual(hints, [
    ['Sec-CH-UA', '"Chromium";v="133", " Not;A Brand";v="99"'],
    ['Sec-CH-UA-Mobile', '?0'],
    ['Sec-CH-UA-Platform', '"Linux"'],
  ]);
});

test('client-hint fallback is empty when the browser does not expose the API', () => {
  assert.deepEqual(defaultUserAgentClientHints(undefined), []);
  assert.deepEqual(defaultUserAgentClientHints({ brands: [], mobile: false, platform: '' }), []);
});

test('client hints merge without changing ordinary headers or duplicating case variants', () => {
  const input = [['Accept', '*/*'], ['sec-ch-ua-mobile', '?1']];
  const result = addMissingClientHintHeaders(input, [
    ['Sec-CH-UA', '"Chromium";v="133"'],
    ['Sec-CH-UA-Mobile', '?0'],
    ['Sec-CH-UA-Platform', '"Linux"'],
  ]);
  assert.deepEqual(result, [
    ['Accept', '*/*'],
    ['sec-ch-ua-mobile', '?1'],
    ['Sec-CH-UA', '"Chromium";v="133"'],
    ['Sec-CH-UA-Platform', '"Linux"'],
  ]);
  assert.deepEqual(input, [['Accept', '*/*'], ['sec-ch-ua-mobile', '?1']]);
});
