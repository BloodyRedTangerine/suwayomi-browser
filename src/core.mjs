/**
 * Browser-local persistence primitives for the Suwayomi browser port.
 *
 * This module deliberately has no DOM dependencies.  Keeping the catalog
 * logic independent of IndexedDB lets us run the same code in a Web Worker,
 * a service-worker-backed app, or the Node test runner.
 */

export const DATABASE_NAME = "suwayomi-browser";
export const DATABASE_VERSION = 1;

export const STORES = Object.freeze({
  manga: "manga",
  chapters: "chapters",
  pages: "pages",
  settings: "settings",
});

const DATA_STORES = [STORES.manga, STORES.chapters, STORES.pages];

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function ensureStoreName(name) {
  if (!Object.values(STORES).includes(name)) {
    throw new Error(`Unknown browser catalog store: ${name}`);
  }
}

function ensureSettingsPrefix(storeName, prefix) {
  ensureStoreName(storeName);
  if (storeName !== STORES.settings) throw new Error('Prefix queries are supported only for the settings store');
  if (typeof prefix !== 'string') throw new TypeError('A string settings-key prefix is required');
}

function settingsKeyRange(prefix) {
  const keyRange = globalThis.IDBKeyRange;
  if (typeof keyRange?.bound !== 'function') throw new Error('IndexedDB key-range queries are unavailable');
  return keyRange.bound(prefix, `${prefix}\uffff`);
}

/**
 * Small in-memory implementation of the persistence contract.
 * It is useful for tests and for embedding the browser core in another host.
 */
export class MemoryStore {
  constructor() {
    this.stores = new Map(Object.values(STORES).map((name) => [name, new Map()]));
    this.locks = new Map();
  }
  exclusive(scope, task) {
    const result = (this.locks.get(scope) || Promise.resolve()).then(task);
    this.locks.set(scope, result.catch(() => {}));
    return result;
  }

  async get(storeName, key) {
    ensureStoreName(storeName);
    return structuredClone(this.stores.get(storeName).get(key));
  }

  async put(storeName, value) {
    ensureStoreName(storeName);
    const key = storeName === STORES.settings ? value.key : value.id;
    if (!key) {
      throw new Error(`Cannot store a ${storeName} record without an id`);
    }
    this.stores.get(storeName).set(key, structuredClone(value));
    return value;
  }

  async delete(storeName, key) {
    ensureStoreName(storeName);
    this.stores.get(storeName).delete(key);
  }

  async getAll(storeName) {
    ensureStoreName(storeName);
    return structuredClone([...this.stores.get(storeName).values()]);
  }

  async getAllByPrefix(storeName, prefix) {
    ensureSettingsPrefix(storeName, prefix);
    return structuredClone([...this.stores.get(storeName).values()]
      .filter(value => value.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key)));
  }

  async getKeysByPrefix(storeName, prefix) {
    ensureSettingsPrefix(storeName, prefix);
    return [...this.stores.get(storeName).keys()]
      .filter(key => key.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right));
  }

  async getPrefixStats(storeName, prefix) {
    const records = await this.getAllByPrefix(storeName, prefix);
    return { count: records.length, blobBytes: records.reduce((total, record) => total + (Number(record.blob?.size) || 0), 0) };
  }

  async clear(storeName) {
    ensureStoreName(storeName);
    this.stores.get(storeName).clear();
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(indexedDBRef, databaseName = DATABASE_NAME) {
  if (!indexedDBRef) {
    throw new Error("IndexedDB is unavailable in this browser");
  }

  return new Promise((resolve, reject) => {
    const request = indexedDBRef.open(databaseName, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORES.manga)) {
        database.createObjectStore(STORES.manga, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.chapters)) {
        const chapters = database.createObjectStore(STORES.chapters, { keyPath: "id" });
        chapters.createIndex("mangaId", "mangaId", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.pages)) {
        const pages = database.createObjectStore(STORES.pages, { keyPath: "id" });
        pages.createIndex("chapterId", "chapterId", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.settings)) {
        database.createObjectStore(STORES.settings, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
  });
}

/** IndexedDB implementation used by the PWA. */
export class IndexedDbStore {
  constructor(indexedDBRef = globalThis.indexedDB, databaseName = DATABASE_NAME) {
    this.databaseName = databaseName;
    this.database = openDatabase(indexedDBRef, databaseName);
  }
  exclusive(scope, task) {
    if (!globalThis.navigator?.locks) return Promise.reject(new Error('This browser must support Web Locks to safely coordinate local library/runtime data across tabs.'));
    return navigator.locks.request('suwayomi:' + this.databaseName + ':' + scope, { mode: 'exclusive' }, task);
  }

  async get(storeName, key) {
    ensureStoreName(storeName);
    const database = await this.database;
    const transaction = database.transaction(storeName, "readonly");
    return requestResult(transaction.objectStore(storeName).get(key));
  }

  async put(storeName, value) {
    ensureStoreName(storeName);
    const database = await this.database;
    const transaction = database.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).put(value);
    await requestResult(request);
    await transactionComplete(transaction);
    return value;
  }

  async delete(storeName, key) {
    ensureStoreName(storeName);
    const database = await this.database;
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await transactionComplete(transaction);
  }

  async getAll(storeName) {
    ensureStoreName(storeName);
    const database = await this.database;
    const transaction = database.transaction(storeName, "readonly");
    return requestResult(transaction.objectStore(storeName).getAll());
  }

  async getAllByPrefix(storeName, prefix) {
    ensureSettingsPrefix(storeName, prefix);
    const database = await this.database;
    const transaction = database.transaction(storeName, 'readonly');
    return requestResult(transaction.objectStore(storeName).getAll(settingsKeyRange(prefix)));
  }

  async getKeysByPrefix(storeName, prefix) {
    ensureSettingsPrefix(storeName, prefix);
    const database = await this.database;
    const transaction = database.transaction(storeName, 'readonly');
    return requestResult(transaction.objectStore(storeName).getAllKeys(settingsKeyRange(prefix)));
  }

  async getPrefixStats(storeName, prefix) {
    ensureSettingsPrefix(storeName, prefix);
    const database = await this.database;
    const transaction = database.transaction(storeName, 'readonly');
    const completion = transactionComplete(transaction);
    const request = transaction.objectStore(storeName).openCursor(settingsKeyRange(prefix));
    return new Promise((resolve, reject) => {
      let count = 0, blobBytes = 0;
      request.onerror = () => reject(request.error ?? new Error('IndexedDB prefix summary failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          completion.then(() => resolve({ count, blobBytes }), reject);
          return;
        }
        count++;
        blobBytes += Number(cursor.value?.blob?.size) || 0;
        cursor.continue();
      };
    });
  }

  async clear(storeName) {
    ensureStoreName(storeName);
    const database = await this.database;
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    await transactionComplete(transaction);
  }
}

function asBlob(page) {
  if (page instanceof Blob) {
    return page;
  }
  if (page?.blob instanceof Blob) {
    return page.blob;
  }
  if (page?.data instanceof Blob) {
    return page.data;
  }
  if (page?.data != null) {
    return new Blob([page.data], { type: page.mimeType ?? "application/octet-stream" });
  }
  throw new Error("A chapter page must contain a Blob or binary data");
}

function pageName(page, index) {
  return page?.name || page?.fileName || `page-${String(index + 1).padStart(3, "0")}`;
}

function pageMimeType(page, blob) {
  return page?.type || page?.mimeType || blob.type || "application/octet-stream";
}

function copyWithoutPages(chapter) {
  return { ...chapter };
}

/**
 * Local catalog facade.  It provides the first browser-native replacement for
 * the server's library/chapter/download persistence APIs.
 */
export class LocalCatalog {
  constructor(store) {
    this.store = store;
  }

  async addManga({
    title,
    author = "",
    description = "",
    sourceId = "local",
    thumbnail = null,
    inLibrary = true,
  }) {
    const normalizedTitle = String(title ?? "").trim();
    if (!normalizedTitle) {
      throw new Error("A manga title is required");
    }

    const manga = {
      id: makeId("manga"),
      title: normalizedTitle,
      author: String(author ?? "").trim(),
      description: String(description ?? "").trim(),
      sourceId,
      thumbnail,
      inLibrary,
      createdAt: now(),
      updatedAt: now(),
    };

    await this.store.put(STORES.manga, manga);
    return manga;
  }

  async updateManga(mangaId, changes) {
    const manga = await this.store.get(STORES.manga, mangaId);
    if (!manga) {
      throw new Error(`Manga not found: ${mangaId}`);
    }

    const updated = {
      ...manga,
      ...changes,
      id: manga.id,
      updatedAt: now(),
    };
    await this.store.put(STORES.manga, updated);
    return updated;
  }

  async setLibraryState(mangaId, inLibrary) {
    return this.updateManga(mangaId, { inLibrary: Boolean(inLibrary) });
  }

  async addChapter({ mangaId, title, number = 1, pages }) {
    const manga = await this.store.get(STORES.manga, mangaId);
    if (!manga) {
      throw new Error(`Manga not found: ${mangaId}`);
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error("A chapter needs at least one page");
    }

    const chapterId = makeId("chapter");
    const createdAt = now();
    const pageRecords = pages.map((page, index) => {
      const blob = asBlob(page);
      return {
        id: makeId("page"),
        chapterId,
        index,
        name: pageName(page, index),
        mimeType: pageMimeType(page, blob),
        blob,
      };
    });

    const chapter = {
      id: chapterId,
      mangaId,
      title: String(title ?? `Chapter ${number}`).trim() || `Chapter ${number}`,
      number: Number(number) || 1,
      pageCount: pageRecords.length,
      completed: false,
      createdAt,
      updatedAt: createdAt,
    };

    for (const page of pageRecords) {
      await this.store.put(STORES.pages, page);
    }
    await this.store.put(STORES.chapters, chapter);
    await this.updateManga(mangaId, { updatedAt: createdAt });
    return { ...chapter, pages: pageRecords };
  }

  async listLibrary() {
    const manga = await this.store.getAll(STORES.manga);
    return manga
      .filter((item) => item.inLibrary !== false)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async listChapters(mangaId) {
    const chapters = (await this.store.getAll(STORES.chapters))
      .filter((chapter) => chapter.mangaId === mangaId)
      .sort((a, b) => a.number - b.number || a.title.localeCompare(b.title));
    return chapters.map(copyWithoutPages);
  }

  async getManga(mangaId) {
    const manga = await this.store.get(STORES.manga, mangaId);
    if (!manga) {
      return null;
    }
    return { ...manga, chapters: await this.listChapters(mangaId) };
  }

  async getChapter(chapterId) {
    const chapter = await this.store.get(STORES.chapters, chapterId);
    if (!chapter) {
      return null;
    }
    const pages = (await this.store.getAll(STORES.pages))
      .filter((page) => page.chapterId === chapterId)
      .sort((a, b) => a.index - b.index);
    return { ...chapter, pages };
  }

  async setProgress(chapterId, pageIndex) {
    const chapter = await this.store.get(STORES.chapters, chapterId);
    if (!chapter) {
      throw new Error(`Chapter not found: ${chapterId}`);
    }
    const boundedPageIndex = Math.max(0, Math.min(Number(pageIndex) || 0, chapter.pageCount - 1));
    const progress = {
      id: `progress:${chapterId}`,
      chapterId,
      pageIndex: boundedPageIndex,
      updatedAt: now(),
    };
    await this.store.put(STORES.settings, { key: progress.id, ...progress });
    return progress;
  }

  async getProgress(chapterId) {
    return this.store.get(STORES.settings, `progress:${chapterId}`);
  }

  async completeChapter(chapterId, completed = true) {
    const chapter = await this.store.get(STORES.chapters, chapterId);
    if (!chapter) {
      throw new Error(`Chapter not found: ${chapterId}`);
    }
    const updated = { ...chapter, completed: Boolean(completed), updatedAt: now() };
    await this.store.put(STORES.chapters, updated);
    return updated;
  }

  async deleteManga(mangaId) {
    const chapters = await this.listChapters(mangaId);
    for (const chapter of chapters) {
      const pages = (await this.store.getAll(STORES.pages)).filter((page) => page.chapterId === chapter.id);
      for (const page of pages) {
        await this.store.delete(STORES.pages, page.id);
      }
      await this.store.delete(STORES.settings, `progress:${chapter.id}`);
      await this.store.delete(STORES.chapters, chapter.id);
    }
    await this.store.delete(STORES.manga, mangaId);
  }
}

export function createBrowserCatalog() {
  return new LocalCatalog(new IndexedDbStore());
}

export const browserCatalogStoreNames = Object.freeze(DATA_STORES);
