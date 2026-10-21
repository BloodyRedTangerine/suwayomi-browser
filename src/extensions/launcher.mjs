export function shouldOpenWebUiAfterInstall(details) {
  return details?.reason === 'install';
}

const APP_TABS_KEY = 'suwayomiBrowserWebUiTabIds';

async function readAppTabIds(api) {
  const result = await api.storage.local.get(APP_TABS_KEY);
  return Array.isArray(result?.[APP_TABS_KEY]) ? result[APP_TABS_KEY].filter(id => Number.isInteger(id)) : [];
}

async function writeAppTabIds(api, ids) {
  await api.storage.local.set({ [APP_TABS_KEY]: [...new Set(ids)].slice(-32) });
}

export async function registerWebUiTab(api, tabId) {
  if (!Number.isInteger(tabId)) return;
  const ids = await readAppTabIds(api);
  await writeAppTabIds(api, [tabId, ...ids.filter(id => id !== tabId)]);
}

export async function forgetWebUiTab(api, tabId) {
  const ids = await readAppTabIds(api);
  if (!ids.includes(tabId)) return;
  await writeAppTabIds(api, ids.filter(id => id !== tabId));
}

export function createOpenWebUi(api) {
  let inFlight;
  return async function openWebUi(launcherTabId) {
    const pending = inFlight ??= (async () => {
      const appUrl = api.runtime.getURL('ui/index.html');
      let registeredIds = [];
      try { registeredIds = await readAppTabIds(api); } catch { /* opening the app does not depend on tab-history storage */ }
      for (const tabId of registeredIds) {
        let existing;
        try {
          existing = await api.tabs.get(tabId);
        } catch { /* a previously registered app tab has since closed */ }
        if (existing?.id != null) {
          try { await api.tabs.update(existing.id, { active: true }); } catch { continue; }
          void registerWebUiTab(api, existing.id).catch(() => {});
          if (existing.windowId != null) {
            try { await api.windows.update(existing.windowId, { focused: true }); } catch { /* tab activation still succeeded */ }
          }
          return existing;
        }
      }
      const created = await api.tabs.create({ url: appUrl, active: true });
      void registerWebUiTab(api, created.id).catch(() => {});
      return created;
    })();
    let appTab;
    try {
      appTab = await pending;
    } finally {
      if (inFlight === pending) inFlight = undefined;
    }
    if (launcherTabId != null && launcherTabId !== appTab.id) {
      try { await api.tabs.remove(launcherTabId); } catch { /* opening the app is more important than closing the transient launcher */ }
    }
    return appTab;
  };
}
