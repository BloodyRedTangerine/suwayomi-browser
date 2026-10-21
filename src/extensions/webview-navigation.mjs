import { exactRequestPattern, WEBVIEW_NAVIGATION_RULE_BASE } from './broker.mjs';
import { permissionPattern } from './permissions.mjs';
import { dnrInitiatorDomains, checkExactHeaderRegex } from './platform.mjs';

const WEBVIEW_NAVIGATION_RULE_END = WEBVIEW_NAVIGATION_RULE_BASE + 100_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNSAFE_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

function navigationHeaders(value) {
  if (value == null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('WebView navigation headers must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('WebView navigation has too many custom headers.');
  const seen = new Set();
  return entries.map(([name, rawValue]) => {
    const header = String(name);
    const normalizedName = header.toLowerCase();
    const content = String(rawValue);
    if (!HEADER_NAME.test(header) || UNSAFE_HEADERS.has(normalizedName))
      throw new Error(`WebView navigation header is not supported: ${header}`);
    if (seen.has(normalizedName)) throw new Error(`WebView navigation header is duplicated: ${header}`);
    seen.add(normalizedName);
    if (/[\r\n\0]/.test(content)) throw new Error(`WebView navigation header contains invalid characters: ${header}`);
    return { header, operation: 'set', value: content };
  });
}

export function createWebViewNavigationBroker(browser) {
  let initialized = false;
  let nextRuleId = WEBVIEW_NAVIGATION_RULE_BASE;
  let queue = Promise.resolve();
  const activeRules = new Set();
  const activeUrlRules = new Map();

  async function initialize() {
    if (initialized) return;
    const stale = (await browser.declarativeNetRequest.getSessionRules())
      .filter(rule => rule.id >= WEBVIEW_NAVIGATION_RULE_BASE && rule.id < WEBVIEW_NAVIGATION_RULE_END)
      .map(rule => rule.id);
    if (stale.length) await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
    initialized = true;
  }

  async function begin(message) {
    await initialize();
    let url;
    try { url = new URL(String(message.url || '')); }
    catch { throw new Error('WebView navigation URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WebView navigation supports only HTTP(S) URLs.');
    if (url.username || url.password) throw new Error('Embedded URL credentials are not supported by WebView navigation.');
    url.hash = '';
    const requestHeaders = navigationHeaders(message.headers);
    const origin = permissionPattern(url.href, browser);
    if (!origin || !await browser.permissions.contains({ origins: [origin] })) {
      const error = new Error(`Enable source access in the extension before opening ${url.hostname}.`);
      error.deniedOrigin = origin;
      throw error;
    }

    if (!requestHeaders.length) return { ok: true, url: url.href };
    if (activeUrlRules.has(url.href)) throw new Error('A WebView navigation with this URL and custom headers is already in progress.');
    const regexFilter = exactRequestPattern(url.href);
    await checkExactHeaderRegex(browser, regexFilter);

    let id = nextRuleId++;
    if (nextRuleId >= WEBVIEW_NAVIGATION_RULE_END) nextRuleId = WEBVIEW_NAVIGATION_RULE_BASE;
    for (let attempts = 0; activeRules.has(id) && attempts < WEBVIEW_NAVIGATION_RULE_END - WEBVIEW_NAVIGATION_RULE_BASE; attempts++) {
      id = nextRuleId++;
      if (nextRuleId >= WEBVIEW_NAVIGATION_RULE_END) nextRuleId = WEBVIEW_NAVIGATION_RULE_BASE;
    }
    if (activeRules.has(id)) throw new Error('WebView navigation header rule capacity is exhausted.');

    activeRules.add(id);
    activeUrlRules.set(url.href, id);
    try {
      await browser.declarativeNetRequest.updateSessionRules({ addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          regexFilter,
          initiatorDomains: dnrInitiatorDomains(browser),
          resourceTypes: ['sub_frame'],
        },
      }], removeRuleIds: [] });
      return { ok: true, url: url.href, ruleId: id };
    } catch (error) {
      activeRules.delete(id);
      if (activeUrlRules.get(url.href) === id) activeUrlRules.delete(url.href);
      throw new Error(`Browser could not apply WebView navigation headers: ${error?.message || error}`);
    }
  }

  async function end(message) {
    const id = Number(message.ruleId);
    if (!Number.isInteger(id) || id < WEBVIEW_NAVIGATION_RULE_BASE || id >= WEBVIEW_NAVIGATION_RULE_END)
      return { ok: true };
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    activeRules.delete(id);
    for (const [url, activeId] of activeUrlRules) if (activeId === id) activeUrlRules.delete(url);
    return { ok: true };
  }

  return (message, sender, sendResponse) => {
    if (sender?.id !== browser.runtime.id || message?.type !== 'suwayomi:webview-navigation') return;
    const operation = async () => {
      if (message.action === 'begin') return begin(message);
      if (message.action === 'end') return end(message);
      throw new Error(`Unsupported WebView navigation operation: ${message.action}`);
    };
    queue = queue.catch(() => {}).then(operation);
    queue.then(sendResponse, async error => {
      if (error?.deniedOrigin && browser.runtime.sendMessage) {
        try { await browser.runtime.sendMessage({ type: 'suwayomi:permission-required', origin: error.deniedOrigin }); } catch {}
      }
      sendResponse({ error: error?.message || String(error) });
    });
    return true;
  };
}
