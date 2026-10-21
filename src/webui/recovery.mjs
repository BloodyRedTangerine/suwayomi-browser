import { IndexedDbStore } from '../core.mjs';
import { BrowserBackend } from './backend.mjs';

const test = new URL(location.href).searchParams.get('test') === 'chapter-sync';
const store = new IndexedDbStore(indexedDB, test ? 'suwayomi-browser-sync-test' : undefined);
const api = new BrowserBackend(store);
const status = document.querySelector('#status'), list = document.querySelector('#chapters');
if (test) document.querySelector('#notice').textContent = 'Isolated chapter-sync test library — synthetic content only.';

async function render() {
  const records = await api.resolve('browserArchivedChapters');
  list.replaceChildren();
  status.textContent = `${records.length} archived chapter${records.length === 1 ? '' : 's'}.`;
  for (const record of records) {
    const row = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
    label.textContent = `${record.mangaTitle} — ${record.name} (${record.url})${record.isRead ? ' · Read' : ''}${record.isBookmarked ? ' · Bookmarked' : ''}`;
    button.textContent = 'Restore'; button.setAttribute('aria-label', `Restore chapter ${record.id}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await api.resolve('browserRestoreArchivedChapters', { input: { ids: [record.id] } }); await render(); }
      catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    row.append(label, button); list.append(row);
  }
}
render().catch(error => { status.textContent = error.message; });
