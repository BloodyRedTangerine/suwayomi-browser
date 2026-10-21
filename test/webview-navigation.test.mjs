import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createWebViewNavigationBroker } from '../src/extensions/webview-navigation.mjs';

for (const platform of ['chrome', 'firefox']) {
const test = (name, ...args) => nodeTest(`${platform}: ${name}`, ...args);
const getURL = function (path) { return (platform === 'firefox' ? 'moz-extension://fixture-uuid/' : `chrome-extension://${this.id}/`) + path; };

function fixture({ granted = true, initialRules = [] } = {}) {
  const changes = [], prompts = [], permissions = [], rules = [...initialRules];
  const browser = {
    runtime: {
      id: 'test-extension', getURL,
      sendMessage: async message => prompts.push(message),
    },
    permissions: { contains: async request => { permissions.push(request); return granted; } },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules],
      isRegexSupported: async () => ({ isSupported: true }),
      updateSessionRules: async change => {
        changes.push(change);
        for (const id of change.removeRuleIds || []) {
          const index = rules.findIndex(rule => rule.id === id);
          if (index >= 0) rules.splice(index, 1);
        }
        rules.push(...(change.addRules || []));
      },
    },
  };
  const broker = createWebViewNavigationBroker(browser);
  const send = (message, senderId = browser.runtime.id) => new Promise(resolve => {
    const asynchronous = broker({ type: 'suwayomi:webview-navigation', ...message }, { id: senderId }, resolve);
    if (senderId === browser.runtime.id) assert.equal(asynchronous, true);
    else assert.equal(asynchronous, undefined);
  });
  return { browser, broker, changes, permissions, prompts, rules, send };
}

test('WebView navigation header rules are exact, extension-initiated subframe rules and are released', async () => {
  const f = fixture({ initialRules: [{ id: 1005 }, { id: 2_000_000_007 }] });
  const response = await f.send({
    action: 'begin',
    url: 'https://reader.example.test/page?q=a*B#fragment',
    headers: { Cookie: 'reader=one', Referer: 'https://reader.example.test/', 'X-Test': 'retained' },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(f.permissions, [{ origins: ['https://reader.example.test/*'] }]);
  assert.deepEqual(f.changes[0].removeRuleIds, [2_000_000_007]);
  const rule = f.rules.find(item => item.id === response.ruleId);
  assert.ok(rule);
  const regex = new RegExp(rule.condition.regexFilter);
  assert.ok(regex.test('https://reader.example.test/page?q=a*B'));
  assert.ok(!regex.test('https://reader.example.test/page?q=axb'));
  assert.deepEqual(rule.condition.initiatorDomains, [platform === 'chrome' ? 'test-extension' : 'fixture-uuid']);
  assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'Cookie', operation: 'set', value: 'reader=one' },
    { header: 'Referer', operation: 'set', value: 'https://reader.example.test/' },
    { header: 'X-Test', operation: 'set', value: 'retained' },
  ]);
  assert.ok(f.rules.some(item => item.id === 1005), 'source broker rules are outside the navigation cleanup range');

  assert.deepEqual(await f.send({ action: 'end', ruleId: response.ruleId }), { ok: true });
  assert.ok(!f.rules.some(item => item.id === response.ruleId));
});

test('WebView navigation requires a granted origin and notifies the local UI to request it', async () => {
  const f = fixture({ granted: false });
  const response = await f.send({ action: 'begin', url: 'https://reader.example.test/challenge' });
  assert.match(response.error, /Enable source access/);
  assert.deepEqual(f.prompts, [{ type: 'suwayomi:permission-required', origin: 'https://reader.example.test/*' }]);
  assert.equal(f.changes.length, 0);
});

test('overlapping custom-header navigations to the same exact URL are rejected until cleanup', async () => {
  const f = fixture();
  const first = await f.send({ action: 'begin', url: 'https://reader.example.test/challenge', headers: { Cookie: 'id=one' } });
  assert.ok(first.ruleId);
  assert.match((await f.send({ action: 'begin', url: 'https://reader.example.test/challenge#different', headers: { Cookie: 'id=two' } })).error, /already in progress/);
  await f.send({ action: 'end', ruleId: first.ruleId });
  assert.ok((await f.send({ action: 'begin', url: 'https://reader.example.test/challenge', headers: { Cookie: 'id=two' } })).ruleId);
});

test('WebView navigation rejects unsafe URLs and malformed or browser-controlled headers', async () => {
  const f = fixture();
  assert.match((await f.send({ action: 'begin', url: 'file:///etc/passwd' })).error, /HTTP\(S\)/);
  assert.match((await f.send({ action: 'begin', url: 'https://user:pass@example.test/' })).error, /credentials/);
  assert.match((await f.send({ action: 'begin', url: 'https://example.test/', headers: { Host: 'other.test' } })).error, /not supported/);
  assert.match((await f.send({ action: 'begin', url: 'https://example.test/', headers: { 'X-Test': 'ok\r\nCookie: stolen=1' } })).error, /invalid characters/);
  assert.match((await f.send({ action: 'begin', url: 'https://example.test/', headers: { Cookie: 'one=1', cookie: 'two=2' } })).error, /duplicated/);
  assert.equal(f.changes.filter(change => change.addRules?.length).length, 0);
});

test('WebView navigation broker ignores messages from other extensions', async () => {
  const f = fixture();
  assert.equal(f.broker({ type: 'suwayomi:webview-navigation', action: 'begin' }, { id: 'untrusted-extension' }, () => {}), undefined);
  assert.equal(f.changes.length, 0);
});

}
