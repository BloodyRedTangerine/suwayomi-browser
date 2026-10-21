import { createSourceBroker } from './src/extensions/broker.mjs';
import { createWebViewNavigationBroker } from './src/extensions/webview-navigation.mjs';
import { createOpenWebUi, forgetWebUiTab, registerWebUiTab, shouldOpenWebUiAfterInstall } from './src/extensions/launcher.mjs';

const browserApi = globalThis.browser ?? globalThis.chrome;
const openWebUi = createOpenWebUi(browserApi);
browserApi.action.onClicked.addListener(() => { void openWebUi().catch(error => console.error('Could not open Suwayomi Browser', error)); });
browserApi.runtime.onInstalled.addListener(details => {
  if (shouldOpenWebUiAfterInstall(details)) void openWebUi().catch(error => console.error('Could not open Suwayomi Browser after install', error));
});
const sourceBroker = createSourceBroker(browserApi);
const webViewNavigationBroker = createWebViewNavigationBroker(browserApi);
browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'suwayomi:open-app') {
    openWebUi(sender.tab?.id).then(tab => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'suwayomi:register-app-tab') {
    registerWebUiTab(browserApi, sender.tab?.id).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === 'suwayomi:webview-navigation') return webViewNavigationBroker(message, sender, sendResponse);
  return sourceBroker(message, sender, sendResponse);
});
browserApi.runtime.onConnect.addListener(port => sourceBroker.connect(port));
browserApi.tabs.onRemoved.addListener(tabId => { void forgetWebUiTab(browserApi, tabId); });
