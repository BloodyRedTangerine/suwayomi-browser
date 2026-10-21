import test from 'node:test';
import assert from 'node:assert/strict';
import { missingPermissionOrigins, permissionPattern, requestPermissionOrigins, sourcePermissionOrigins } from '../src/extensions/permissions.mjs';

test('Permission patterns normalize source home URLs to deduplicated origins', () => {
  assert.equal(permissionPattern('https://source-b.test/api/v5/'), 'https://source-b.test/*');
  assert.equal(permissionPattern('http://localhost:8080/source'), 'http://localhost:8080/*');
  assert.equal(permissionPattern('file:///tmp/source'), null);
  assert.equal(permissionPattern('https://user:pass@example.test/'), null);
  assert.deepEqual(sourcePermissionOrigins([
    { baseUrl: 'https://source-b.test/a' },
    { homeUrl: 'https://source-b.test/b' },
    { baseUrl: 'https://source-a.test/' },
    { baseUrl: 'not a URL' },
  ]), ['https://source-a.test/*', 'https://source-b.test/*']);
});

test('Permission helpers check and request only missing origins', async () => {
  const checked = [], requested = [];
  const browser = {
    permissions: {
      contains: async ({ origins }) => { checked.push(origins[0]); return origins[0] === 'https://already.test/*'; },
      request: async ({ origins }) => { requested.push(origins); return true; },
    },
  };
  assert.deepEqual(await missingPermissionOrigins(browser, ['https://new.test/*', 'https://already.test/*', 'https://new.test/*']), ['https://new.test/*']);
  assert.deepEqual(checked, ['https://already.test/*', 'https://new.test/*']);
  assert.equal(await requestPermissionOrigins(browser, ['https://new.test/*', 'https://new.test/*']), true);
  assert.deepEqual(requested, [['https://new.test/*']]);
});
