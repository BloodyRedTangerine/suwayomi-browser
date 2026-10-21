import { IndexedDbStore } from '../core.mjs';
import { matchesFilter, validateFilter, withFilterValues } from './filters.mjs';
import { ExtensionManager } from '../extensions/manager.mjs';
import { sourceFetch, decodeBytes } from '../extensions/transport.mjs';
import { permissionPattern, sourcePermissionOrigins, artifactPermissionOrigins, missingPermissionOrigins, permissionCovers } from '../extensions/permissions.mjs';
import { getPermissionRecovery } from '../extensions/permission-recovery.mjs';
import { permissionDenials } from '../extensions/permission-denial.mjs';
import { fetchRepository, repositoryUrl } from '../extensions/repository.mjs';
import { categoryFields, mutateCategories } from './categories.mjs';
import { queueState, chapterIds, reorderDownloads } from './downloads.mjs';
import { activeUpdaterJob, categoryIds, clearUpdater, normalizeUpdaterState, updaterIsRunning, updaterState } from './updater.mjs';
import { createBrowserDiagnostics, recordBrowserDiagnosticError } from './diagnostics.mjs';

const typed = (__typename, fields = {}) => ({ __typename, ...fields });
const epoch = () => Math.floor(Date.now() / 1000);
function browserExtensionVersion() {
  try {
    const version = globalThis.chrome?.runtime?.getManifest?.().version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch { return '0.0.0'; }
}
const unsupported = name => { throw new Error(`The browser backend has not implemented ${name}. No desktop server is contacted.`); };
const fieldName = key => key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const BROWSER_BACKUP_FORMAT = 'suwayomi-browser-backup';
const BROWSER_BACKUP_VERSION = 1;
const BROWSER_BACKUP_MAX_BYTES = 32 * 1024 * 1024;
export const LIBRARY_SCHEMA_VERSION = 2;
function collectStrings(value, output = [], seen = new Set()) {
  if (typeof value === 'string') { output.push(value); return output; }
  if (!value || typeof value !== 'object' || value instanceof Blob || ArrayBuffer.isView(value) || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) collectStrings(item, output, seen);
  else for (const item of Object.values(value)) collectStrings(item, output, seen);
  return output;
}
function libraryPrivateStrings(db) {
  return [
    ...(db?.mangas || []).map(manga => manga.title),
    ...(db?.chapters || []).map(chapter => chapter.name),
  ].filter(value => typeof value === 'string');
}
function downloadErrorMessage(error) {
  const message = String(error?.message || error || 'Download failed');
  if (error?.name === 'QuotaExceededError' || /\bquota\b/i.test(message))
    return 'Browser storage quota exceeded. Free storage or delete cached pages, then retry.';
  return message.slice(0, 2000);
}
function expiredImageAddress(error) {
  if (permissionDenials(error).length) return false;
  return [403, 404, 410].includes(error?.status)
    || /\bHTTP(?:\s+error|\s+status)?\s*[:=]?\s*(?:403|404|410)\b/i.test(String(error?.message || ''));
}
const BROWSER_BACKUP_FLAGS = Object.freeze({
  includeManga: true, includeCategories: true, includeChapters: true,
  includeTracking: true, includeHistory: true, includeClientData: true,
  includeServerSettings: true, includeUserSettings: true,
});
const LOCAL_TRACKER_ID = 0;
const LOCAL_TRACKER_STATUSES = Object.freeze([
  { name: 'Planned', value: 1 },
  { name: 'Reading', value: 2 },
  { name: 'Completed', value: 3 },
  { name: 'On hold', value: 4 },
  { name: 'Dropped', value: 5 },
]);
const LOCAL_TRACKER_SCORES = Object.freeze(['0', '1', '2', '3', '4', '5']);
const UNSET_TRACK_DATE = '0';
const backupId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const backupFlags = flags => Object.fromEntries(Object.keys(BROWSER_BACKUP_FLAGS).map(key => [key, flags?.[key] ?? BROWSER_BACKUP_FLAGS[key]]));
const LOCAL_SETTINGS_DEFAULTS = Object.freeze({
  updateMangas: false,
  excludeUnreadChapters: true,
  excludeNotStarted: true,
  excludeCompleted: true,
  autoDownloadNewChapters: false,
  excludeEntryWithUnreadChapters: true,
  autoDownloadNewChaptersLimit: 0,
  autoDownloadIgnoreReUploads: false,
  globalUpdateInterval: 0,
});

function defaultCategory() {
  return { id: 0, name: 'Default', default: false, order: 0, isDefaultCategory: true, includeInUpdate: 'UNSET', includeInDownload: 'UNSET' };
}

function defaultUpdaterState() {
  return { state: 'STOPPED', queue: [], categoryUpdates: [], skippedCategoryIds: [], skippedMangaIds: [], skippedCategoriesCount: 0, lastUpdateTimestamp: 0 };
}

function migrateLibrarySchema1To2(value) {
  const migrated = { ...value };
  for (const field of ['mangas', 'chapters', 'meta', 'repositories', 'sourceMeta', 'trackRecords']) {
    if (migrated[field] == null) migrated[field] = [];
    else if (!Array.isArray(migrated[field])) throw new Error(`Library schema 1 field ${field} must be an array`);
  }
  if (migrated.categories == null) migrated.categories = [defaultCategory()];
  else if (!Array.isArray(migrated.categories)) throw new Error('Library schema 1 field categories must be an array');
  if (migrated.settings == null) migrated.settings = {};
  else if (typeof migrated.settings !== 'object' || Array.isArray(migrated.settings)) throw new Error('Library schema 1 field settings must be an object');
  if (migrated.downloads == null) migrated.downloads = { state: 'STOPPED', queue: [] };
  else if (typeof migrated.downloads !== 'object' || Array.isArray(migrated.downloads)) throw new Error('Library schema 1 field downloads must be an object');
  else {
    migrated.downloads = { ...migrated.downloads };
    if (migrated.downloads.state == null) migrated.downloads.state = 'STOPPED';
    else if (typeof migrated.downloads.state !== 'string') throw new Error('Library schema 1 downloads.state must be a string');
    if (migrated.downloads.queue == null) migrated.downloads.queue = [];
    else if (!Array.isArray(migrated.downloads.queue)) throw new Error('Library schema 1 downloads.queue must be an array');
  }
  if (migrated.updater == null) migrated.updater = defaultUpdaterState();
  else if (typeof migrated.updater !== 'object' || Array.isArray(migrated.updater)) throw new Error('Library schema 1 field updater must be an object');
  else migrated.updater = { ...defaultUpdaterState(), ...migrated.updater };
  if (migrated.backupRestores == null) migrated.backupRestores = {};
  else if (typeof migrated.backupRestores !== 'object' || Array.isArray(migrated.backupRestores)) throw new Error('Library schema 1 field backupRestores must be an object');
  if (migrated.nextId == null) {
    const highestId = [...migrated.mangas, ...migrated.chapters, ...migrated.categories]
      .reduce((max, record) => Math.max(max, Number(record?.id) || 0), 0);
    migrated.nextId = highestId + 1;
  } else if (!Number.isSafeInteger(migrated.nextId) || migrated.nextId < 1) throw new Error('Library schema 1 nextId must be a positive safe integer');
  if (migrated.nextTrackId == null) migrated.nextTrackId = 1;
  else if (!Number.isSafeInteger(migrated.nextTrackId) || migrated.nextTrackId < 1) throw new Error('Library schema 1 nextTrackId must be a positive safe integer');
  migrated.schemaVersion = 2;
  return migrated;
}

export const LIBRARY_MIGRATIONS = Object.freeze([
  Object.freeze({ from: 1, to: 2, migrate: migrateLibrarySchema1To2 }),
]);

export function createDefaultLibraryData() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    nextId: 1,
    nextTrackId: 1,
    mangas: [],
    chapters: [],
    categories: [defaultCategory()],
    meta: [],
    repositories: [],
    sourceMeta: [],
    settings: {},
    trackRecords: [],
    downloads: { state: 'STOPPED', queue: [] },
    updater: defaultUpdaterState(),
    backupRestores: {},
  };
}

export function migrateLibraryData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Saved browser library must be an object');
  let migrated = structuredClone(value);
  let version = migrated.schemaVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`Unsupported browser library schema version: ${version}`);
  if (version > LIBRARY_SCHEMA_VERSION) throw new Error(`Browser library schema ${version} is newer than this build supports (latest ${LIBRARY_SCHEMA_VERSION})`);
  for (const step of LIBRARY_MIGRATIONS) {
    if (version === LIBRARY_SCHEMA_VERSION) break;
    if (step.from < version) continue;
    if (step.from !== version || step.to !== version + 1) throw new Error(`Browser library migrations are not ordered at schema ${version}`);
    migrated = step.migrate(migrated);
    version = step.to;
    migrated.schemaVersion = version;
  }
  if (version !== LIBRARY_SCHEMA_VERSION) throw new Error(`No browser library migration path from schema ${version} to ${LIBRARY_SCHEMA_VERSION}`);
  for (const field of ['mangas', 'chapters', 'categories', 'meta', 'repositories', 'sourceMeta', 'trackRecords']) {
    if (!Array.isArray(migrated[field])) throw new Error(`Browser library schema ${version} field ${field} must be an array`);
  }
  if (!migrated.settings || typeof migrated.settings !== 'object' || Array.isArray(migrated.settings)) throw new Error(`Browser library schema ${version} field settings must be an object`);
  if (!migrated.downloads || typeof migrated.downloads !== 'object' || Array.isArray(migrated.downloads)) throw new Error(`Browser library schema ${version} field downloads must be an object`);
  if (!migrated.updater || typeof migrated.updater !== 'object' || Array.isArray(migrated.updater)) throw new Error(`Browser library schema ${version} field updater must be an object`);
  if (!migrated.backupRestores || typeof migrated.backupRestores !== 'object' || Array.isArray(migrated.backupRestores)) throw new Error(`Browser library schema ${version} field backupRestores must be an object`);
  return migrated;
}

function scalarEqual(actual, expected) {
  // GraphQL LongString inputs use decimal strings; stored timestamps are
  // numbers. Compare integer values exactly rather than rounding long inputs.
  if (Number.isSafeInteger(actual) && typeof expected === 'string' && /^-?\d+$/.test(expected)) return BigInt(actual) === BigInt(expected);
  return actual === expected;
}

function uniqueSourceChapters(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!item || typeof item.url !== 'string' || typeof item.name !== 'string' || !Number.isFinite(item.number) || !Number.isFinite(item.dateUpload)) throw new Error('Source returned an invalid chapter');
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

function matches(value, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, test]) => {
    if (key === 'and') return test.every(part => matches(value, part));
    if (key === 'or') return test.some(part => matches(value, part));
    if (key === 'not') return !matches(value, test);
    if (test === undefined) return true;
    // The server's categoryId filter is a join, not a scalar manga property.
    // Category zero represents no explicit category in its GraphQL API.
    if (key === 'categoryId' && value.categoryIds) {
      const ids = value.categoryIds.filter(id => id !== 0);
      if (!test || typeof test !== 'object') return ids.includes(test);
      return Object.entries(test).every(([operation, expected]) => expected === undefined ||
        (operation === 'isNull' ? (expected ? !ids.length : !!ids.length) :
          ids.some(id => matches({ id }, { id: { [operation]: expected } }))));
    }
    const actual = value[key];
    if (test === null || typeof test !== 'object' || Array.isArray(test)) return actual === test;
    return Object.entries(test).every(([operation, expected]) => {
      if (expected === undefined) return true;
      switch (operation) {
        case 'equalTo': return actual === expected;
        case 'notEqualTo': return actual !== expected;
        case 'notEqualToAll': case 'notEqualToAny': {
          if (!Array.isArray(expected) || expected.some(value => value == null)) throw new TypeError(operation + ' requires a non-null value array');
          if (!expected.length) return true; // Upstream omits empty clauses.
          if (actual == null) return false; // SQL inequality does not match NULL.
          // Upstream negates ALL/ANY: notEqualToAll combines inequalities
          // with OR, whereas notEqualToAny combines them with AND.
          return operation === 'notEqualToAll'
            ? expected.some(value => !scalarEqual(actual, value))
            : expected.every(value => !scalarEqual(actual, value));
        }
        case 'in': return expected.includes(actual);
        case 'notIn': return !expected.includes(actual);
        case 'isNull': return expected ? actual == null : actual != null;
        case 'greaterThan': return actual > expected;
        case 'greaterThanOrEqualTo': return actual >= expected;
        case 'lessThan': return actual < expected;
        case 'lessThanOrEqualTo': return actual <= expected;
        case 'includes': return String(actual).includes(expected);
        case 'includesInsensitive': case 'includesIgnoreCase': return String(actual).toLowerCase().includes(String(expected).toLowerCase());
        default: unsupported('filter operator ' + operation);
      }
    });
  });
}

export function connection(type, all, args = {}) {
  validateFilter(args.filter,type);
  let nodes = all.filter(node => matches(node, args.condition) && matchesFilter(node, args.filter, type));
  const totalCount = nodes.length;
  for (const order of [...(args.order || [])].reverse()) {
    const key = fieldName(order.by || 'id');
    nodes.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key] || '') : (a[key] || 0) - (b[key] || 0)) * ((order.byType || order.direction) === 'DESC' ? -1 : 1));
  }
  const offset = args.offset || (args.after ? Number(atob(args.after)) + 1 : 0);
  const end = args.first == null ? nodes.length : offset + args.first;
  nodes = nodes.slice(offset, end);
  if (args.last != null) nodes = nodes.slice(-args.last);
  return typed(type + 'NodeList', {
    nodes, edges: nodes.map((node, index) => ({ node, cursor: btoa(String(index + offset)) })), totalCount,
    pageInfo: typed('PageInfo', { hasNextPage: end < totalCount, hasPreviousPage: offset > 0, startCursor: nodes.length ? btoa(String(offset)) : null, endCursor: nodes.length ? btoa(String(offset + nodes.length - 1)) : null }),
  });
}

/** Persistent local implementation of the WebUI's GraphQL data model.
 * Source execution is delegated to the APK/JAR worker, never an HTTP server.
 * Unimplemented server-only operations fail explicitly, not with fake success.
 */
export class BrowserBackend {
  constructor(store, { manager, workerUrl, transport, permissionRecovery = globalThis.document && globalThis.chrome?.runtime?.id ? getPermissionRecovery() : null, autoDownloads = true, autoUpdates = true, version = browserExtensionVersion() } = {}) {
    this.store = store;
    this.version = version;
    this.manager = manager || new ExtensionManager(store, { workerUrl, transport });
    this.transport = transport || sourceFetch;
    this.listeners = new Set();
    this.backupObjectUrls = new Set();
    this.autoDownloads = autoDownloads;
    this.autoUpdates = autoUpdates;
    this.permissionRecovery = permissionRecovery;
    this.nextPermissionImage = 0;
    this.stopPermissionGrants = permissionRecovery?.subscribeGranted(patterns => this.resumePermissionDownloads(patterns));
    this.loading = this.load();
    this.mutations = Promise.resolve();
    this.loading.then(() => { this.kickDownloads(); this.kickUpdater(); this.scheduleUpdater(); }).catch(error => {
      recordBrowserDiagnosticError(error);
      this.downloadFailure = error; this.updaterFailure = error;
    });
  }
  async load() {
    const saved = await this.store.get('settings', 'webui:database');
    const hasSavedLibrary = saved?.value != null;
    const storedVersion = hasSavedLibrary ? (saved.value.schemaVersion ?? 1) : LIBRARY_SCHEMA_VERSION;
    this.db = hasSavedLibrary ? migrateLibraryData(saved.value) : createDefaultLibraryData();
    const highestTrackId = this.db.trackRecords.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0);
    this.db.nextTrackId = Math.max(Number(this.db.nextTrackId) || 1, highestTrackId + 1);
    for (const record of this.db.trackRecords) {
      record.startDate = this.normalizeTrackDate(record.startDate, 'startDate');
      record.finishDate = this.normalizeTrackDate(record.finishDate, 'finishDate');
    }
    normalizeUpdaterState(updaterState(this.db));
    if (hasSavedLibrary && storedVersion < LIBRARY_SCHEMA_VERSION)
      await this.store.put('settings', { key: 'webui:database', value: this.db });
  }
  async save() {
    await this.store.put('settings', { key: 'webui:database', value: this.db });
    this.downloadFailure = undefined;
    this.updaterFailure = undefined;
    for (const listener of this.listeners) listener();
    try { this.downloadChannel?.postMessage('changed'); }
    catch (error) { this.downloadNotificationFailure = error; this.downloadChannel?.close(); this.downloadChannel = null; }
  }
  watchDownloads() {
    if (this.downloadChannel || this.disposed || !this.store.databaseName || !globalThis.document || !globalThis.BroadcastChannel) return;
    this.downloadChannel = new BroadcastChannel('suwayomi:' + this.store.databaseName + ':downloads');
    this.downloadChannel.onmessage = () => {
      this.resolve('downloadStatus').then(() => { this.kickUpdater(); for (const listener of this.listeners) listener(); }).catch(error => { this.downloadFailure = error; this.updaterFailure = error; });
    };
  }
  dispose() {
    this.stopPermissionGrants?.();
    this.disposed = true; clearTimeout(this.updaterTimer); this.updaterTimer = null; this.downloadChannel?.close(); this.downloadChannel = null; this.listeners.clear();
    for (const url of this.backupObjectUrls) globalThis.URL?.revokeObjectURL?.(url);
    this.backupObjectUrls.clear();
    this.manager.runtime?.dispose();
  }
  downloadItem(row, position) {
    const chapter = this.db.chapters.find(chapter => chapter.id === row.chapterId) || this.db.archivedChapters?.find(chapter => chapter.id === row.chapterId);
    if (!chapter) throw new Error('Queued chapter no longer exists: ' + row.chapterId);
    return typed('DownloadType', { chapter: this.chapter(chapter), manga: this.manga(this.find('mangas', chapter.mangaId)), state: row.state, progress: row.progress, tries: row.tries, position, error: row.error ?? null });
  }
  downloadStatus() {
    if (this.downloadFailure) throw new Error('Local downloader failed: ' + (this.downloadFailure.message || this.downloadFailure));
    const downloads = queueState(this.db);
    return typed('DownloadStatus', { state: downloads.state, queue: downloads.queue.map((row, index) => this.downloadItem(row, index)) });
  }
  kickDownloads() {
    if (!this.autoDownloads || this.disposed || this.downloadTask || this.db?.downloads?.state !== 'STARTED' || !this.db.downloads.queue.some(row => row.state !== 'ERROR')) return this.downloadTask;
    this.watchDownloads();
    // One tab owns the runner. Individual page operations release the library
    // lock so stop/dequeue/reorder can take effect at the next request boundary.
    let failed = false;
    this.downloadTask = this.store.exclusive('download-runner', async () => {
      while (!this.disposed && await this.coordinated(() => this.downloadStep())) { /* persisted page boundaries */ }
    }).catch(error => {
      failed = true; this.downloadFailure = error;
      recordBrowserDiagnosticError(error);
      for (const listener of this.listeners) listener();
    }).finally(() => {
      this.downloadTask = null;
      if (!failed) this.kickDownloads(); // Do not lose an enqueue racing runner exit.
    });
    return this.downloadTask;
  }
  async downloadStep() {
    const downloads = queueState(this.db);
    if (downloads.state !== 'STARTED') return false;
    const row = downloads.queue.find(row => row.state !== 'ERROR');
    if (!row) { downloads.state = 'STOPPED'; await this.save(); return false; }
    if (!this.db.chapters.some(chapter => String(chapter.id) === String(row.chapterId))) {
      const keys = await this.store.getKeysByPrefix('settings', `webui:page:${row.chapterId}:`);
      for (const key of keys) await this.store.delete('settings', key);
      downloads.queue = downloads.queue.filter(item => String(item.chapterId) !== String(row.chapterId));
      if (!downloads.queue.some(item => item.state !== 'ERROR')) downloads.state = 'STOPPED';
      await this.save();
      return downloads.state === 'STARTED';
    }
    try {
      const chapter = this.find('chapters', row.chapterId);
      if (row.state === 'QUEUED') {
        row.state = 'DOWNLOADING'; row.tries++; row.manifestReady = false;
        await this.save(); return true;
      }
      if (!row.manifestReady) {
        await this.resolveOperation('fetchChapterPages', { input: { chapterId: chapter.id } });
        if (!chapter.pages?.length) throw new Error('Source returned no chapter pages');
        row.manifestReady = true; await this.save(); return true;
      }
      if (!chapter.pages?.length) throw new Error('Chapter page manifest is empty');
      let cached = await this.cachedChapterPages(chapter);
      const missing = cached.findIndex(page => !page);
      if (missing >= 0) await this.fetchOperation(`/browser-local/chapter/${chapter.id}/page/${missing}`);
      cached = await this.cachedChapterPages(chapter);
      row.progress = cached.length ? cached.filter(Boolean).length / cached.length : 0;
      if (cached.length && cached.every(Boolean)) {
        chapter.isDownloaded = true;
        downloads.queue = downloads.queue.filter(item => item !== row);
      }
      if (!downloads.queue.some(item => item.state !== 'ERROR')) downloads.state = 'STOPPED';
      await this.save(); return downloads.state === 'STARTED';
    } catch (error) {
      if (this.disposed) return false; // Keep the durable checkpoint for another tab.
      recordBrowserDiagnosticError(error);
      row.state = 'ERROR'; row.error = downloadErrorMessage(error);
      row.deniedOrigins = permissionDenials(error);
      if (row.deniedOrigins.length) this.permissionRecovery?.noteDeniedOrigins(row.deniedOrigins);
      if (!downloads.queue.some(item => item.state !== 'ERROR')) downloads.state = 'STOPPED';
      await this.save(); return downloads.state === 'STARTED';
    }
  }
  localSettings() { return { ...LOCAL_SETTINGS_DEFAULTS, ...(this.db.settings || {}) }; }
  async resumePermissionDownloads(patterns) {
    await this.coordinated(async () => {
      const downloads = queueState(this.db);
      let resumed = false;
      for (const row of downloads.queue) {
        const denied = permissionDenials(row);
        if (row.state !== 'ERROR' || !denied.length || !denied.every(origin => patterns.some(pattern => permissionCovers(pattern, origin)))) continue;
        row.state = 'QUEUED'; row.error = null; row.deniedOrigins = []; resumed = true;
      }
      if (resumed) { downloads.state = 'STARTED'; await this.save(); }
    });
    this.kickDownloads();
  }
  async preparePagePermissions(pages) {
    if (!this.permissionRecovery || !globalThis.chrome?.permissions?.contains) return;
    const origins = [...new Set(pages.map(page => permissionPattern(page.imageUrl)).filter(Boolean))];
    this.permissionRecovery.noteDeniedOrigins(await missingPermissionOrigins(globalThis.chrome, origins));
  }
  settingsPayload() {
    const local = this.localSettings();
    return typed('SettingsType', {
      // Native server-only settings remain unavailable (null).  These values
      // are intentionally not presented as desktop capabilities.
      // The official WebUI still renders a few of these fields on settings
      // screens and expects the GraphQL non-null scalar contract.  Use empty
      // browser-local values for path/text settings instead of returning
      // null, which would make the upstream screen call `.length` on null.
      maxSourcesInParallel: 1, authMode: 'NONE', downloadAsCbz: false,
      localSourcePath: '', electronPath: '', downloadsPath: '',
      downloadConversions: [], serveConversions: [], webUIFlavor: 'WEBUI', webUIChannel: 'BUNDLED',
      webUIUpdateCheckInterval: 0, initialOpenInBrowserEnabled: false,
      webUIInterface: 'BROWSER', flareSolverrEnabled: false, kcefEnabled: false,
      syncYomiEnabled: false, backupInterval: 0, syncInterval: 0,
      backupPath: '', backupTime: '00:00', backupTTL: 0,
      autoBackupIncludeCategories: true, autoBackupIncludeChapters: true,
      autoBackupIncludeClientData: true, autoBackupIncludeHistory: true,
      autoBackupIncludeManga: true, autoBackupIncludeServerSettings: false,
      autoBackupIncludeTracking: true,
      ...local,
    });
  }
  async readBrowserBackup(file) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('A browser backup file is required');
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > BROWSER_BACKUP_MAX_BYTES) throw new Error('Browser backup exceeds 32 MiB');
    let backup;
    try { backup = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error('Browser backup is not valid UTF-8 JSON'); }
    if (!backup || backup.format !== BROWSER_BACKUP_FORMAT || backup.version !== BROWSER_BACKUP_VERSION) {
      throw new Error('Unsupported backup format; this browser build accepts only its local JSON backups');
    }
    for (const key of ['mangas', 'chapters', 'categories', 'sources', 'trackRecords']) if (backup[key] != null && !Array.isArray(backup[key])) throw new Error(`Browser backup field ${key} must be an array`);
    return backup;
  }
  async createBrowserBackup(input = {}) {
    const requested = backupFlags(input.flags);
    const flags = { ...requested, includeServerSettings: false };
    const sources = (await this.manager.sources()).map(source => ({ id: String(source.id), name: source.name, lang: source.lang, baseUrl: source.baseUrl }));
    const manga = flags.includeManga ? this.db.mangas.map(record => structuredClone(record)) : [];
    const chapters = flags.includeManga && flags.includeChapters ? this.db.chapters.map(record => ({ ...structuredClone(record), isDownloaded: false })) : [];
    const libraryIds = new Set(manga.filter(record => record.inLibrary).map(record => record.id));
    const payload = {
      format: BROWSER_BACKUP_FORMAT, version: BROWSER_BACKUP_VERSION, createdAt: new Date().toISOString(), flags,
      sources,
      categories: flags.includeCategories ? structuredClone(this.db.categories) : [],
      mangas: manga.filter(record => record.inLibrary), chapters,
      trackRecords: flags.includeManga && flags.includeTracking ? structuredClone(this.db.trackRecords || []).filter(record => libraryIds.has(record.mangaId)) : [],
      meta: flags.includeClientData ? structuredClone(this.db.meta || []) : [],
      sourceMeta: flags.includeClientData ? structuredClone(this.db.sourceMeta || []) : [],
      repositories: flags.includeClientData ? structuredClone(this.db.repositories || []) : [],
      settings: flags.includeUserSettings ? structuredClone(this.localSettings()) : {},
    };
    const id = backupId();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    await this.store.put('settings', { key: `webui:backup:${id}`, blob, createdAt: Date.now() });
    const route = `/browser-local/backup/${id}`;
    const url = globalThis.document && globalThis.URL?.createObjectURL ? URL.createObjectURL(blob) : route;
    if (url !== route) this.backupObjectUrls.add(url);
    return { clientMutationId: input.clientMutationId ?? null, url };
  }
  async validateBrowserBackup(file) {
    const backup = await this.readBrowserBackup(file);
    const installed = new Map((await this.manager.sources()).map(source => [String(source.id), source]));
    const missingSources = (backup.sources || []).filter(source => !installed.has(String(source.id))).map(source => ({ __typename: 'ValidateBackupSource', id: String(source.id), name: source.name || String(source.id) }));
    return { missingSources, missingTrackers: [] };
  }
  async restoreBrowserBackup(input = {}) {
    const backup = await this.readBrowserBackup(input.backup);
    const flags = backupFlags(input.flags);
    const validation = await this.validateBrowserBackup(input.backup);
    const restoreId = backupId();
    const state = { state: 'RESTORING_CATEGORIES', totalManga: flags.includeManga ? (backup.mangas || []).length : 0, mangaProgress: 0 };
    this.db.backupRestores ||= {};
    this.db.backupRestores[restoreId] = state;
    if (flags.includeCategories && backup.categories?.length) this.db.categories = structuredClone(backup.categories);
    if (flags.includeManga) {
      this.db.mangas = structuredClone(backup.mangas || []).map(manga => ({ ...manga, inLibrary: true }));
      if (flags.includeChapters) this.db.chapters = structuredClone(backup.chapters || []).map(chapter => ({ ...chapter, isDownloaded: false, browserPagesNeedRefresh: true }));
      else this.db.chapters = [];
      this.db.archivedChapters = [];
      this.db.trackRecords = flags.includeTracking
        ? structuredClone(backup.trackRecords || []).filter(record => this.db.mangas.some(manga => String(manga.id) === String(record.mangaId)))
        : [];
    }
    if (flags.includeClientData) {
      this.db.meta = structuredClone(backup.meta || []);
      this.db.sourceMeta = structuredClone(backup.sourceMeta || []);
      this.db.repositories = structuredClone(backup.repositories || []);
    }
    if (flags.includeUserSettings) this.db.settings = { ...LOCAL_SETTINGS_DEFAULTS, ...(backup.settings || {}) };
    this.db.categories ||= [{ id: 0, name: 'Default', default: false, order: 0, isDefaultCategory: true, includeInUpdate: 'UNSET', includeInDownload: 'UNSET' }];
    if (!this.db.categories.some(category => category.id === 0)) this.db.categories.unshift({ id: 0, name: 'Default', default: false, order: 0, isDefaultCategory: true, includeInUpdate: 'UNSET', includeInDownload: 'UNSET' });
    const maxId = [...this.db.mangas, ...this.db.chapters, ...this.db.categories].reduce((max, record) => Math.max(max, Number(record.id) || 0), 0);
    this.db.nextId = Math.max(Number(this.db.nextId) || 1, maxId + 1);
    const maxTrackId = (this.db.trackRecords || []).reduce((max, record) => Math.max(max, Number(record.id) || 0), 0);
    this.db.nextTrackId = Math.max(Number(this.db.nextTrackId) || 1, maxTrackId + 1);
    this.db.downloads = { state: 'STOPPED', queue: [] };
    clearUpdater(normalizeUpdaterState(updaterState(this.db)));
    const cachedKeys = (await Promise.all(['webui:page:', 'webui:thumbnail:']
      .map(prefix => this.store.getKeysByPrefix('settings', prefix)))).flat();
    for (const key of cachedKeys) await this.store.delete('settings', key);
    state.state = 'SUCCESS'; state.mangaProgress = state.totalManga;
    this.db.backupRestores[restoreId] = state;
    await this.save();
    return { clientMutationId: input.clientMutationId ?? null, id: restoreId, status: typed('BackupRestoreStatus', state), missingSources: validation.missingSources };
  }
  browserRestoreStatus(id) {
    const state = this.db.backupRestores?.[id];
    return state ? typed('BackupRestoreStatus', state) : null;
  }
  updaterItem(row) {
    const manga = this.find('mangas', row.mangaId);
    return typed('MangaUpdateType', {
      status: row.state,
      manga: () => this.manga(manga),
      // These fields are local diagnostics; the official GraphQL fragment
      // ignores them, while browser-specific tooling can inspect failures.
      error: row.error ?? null,
      tries: row.tries || 0,
    });
  }
  updaterStatus() {
    if (this.updaterFailure) throw new Error('Local updater failed: ' + (this.updaterFailure.message || this.updaterFailure));
    const state = normalizeUpdaterState(updaterState(this.db));
    const categoryUpdates = state.categoryUpdates
      .filter(row => row.status === 'UPDATING' && this.db.categories.some(category => category.id === row.categoryId))
      .map(row => typed('CategoryUpdateType', { status: 'UPDATING', category: () => this.category(this.find('categories', row.categoryId)) }));
    const finishedJobs = state.queue.filter(row => row.state === 'COMPLETE' || row.state === 'FAILED').length;
    return typed('LibraryUpdateStatus', {
      jobsInfo: typed('UpdaterJobsInfoType', {
        isRunning: updaterIsRunning(state), totalJobs: state.queue.length, finishedJobs,
        skippedCategoriesCount: state.skippedCategoriesCount, skippedMangasCount: state.skippedMangaIds.length,
      }),
      mangaUpdates: state.queue.map(row => this.updaterItem(row)), categoryUpdates,
    });
  }
  updaterUpdates() {
    const status = this.updaterStatus();
    return typed('UpdaterUpdates', {
      omittedUpdates: false, initial: null, jobsInfo: status.jobsInfo,
      mangaUpdates: status.mangaUpdates, categoryUpdates: status.categoryUpdates,
    });
  }
  legacyUpdateStatus() {
    const state = normalizeUpdaterState(updaterState(this.db));
    const mangas = rows => ({ mangas: args => connection('Manga', rows.map(row => this.manga(this.find('mangas', row.mangaId ?? row))), args) });
    const categories = ids => ({ categories: args => connection('Category', ids.map(id => this.category(this.find('categories', id))), args) });
    const by = status => state.queue.filter(row => row.state === status);
    return typed('UpdateStatus', {
      isRunning: updaterIsRunning(state),
      skippedCategories: categories(state.skippedCategoryIds),
      updatingCategories: categories(state.categoryUpdates.filter(row => row.status === 'UPDATING').map(row => row.categoryId)),
      pendingJobs: mangas(by('PENDING')), runningJobs: mangas(by('RUNNING')),
      completeJobs: mangas(by('COMPLETE')), failedJobs: mangas(by('FAILED')),
      skippedJobs: mangas(state.skippedMangaIds),
    });
  }
  kickUpdater() {
    const state = this.db && normalizeUpdaterState(updaterState(this.db));
    if (!this.autoUpdates || this.disposed || this.updaterTask || !state || state.state !== 'STARTED' || !state.queue.some(activeUpdaterJob)) return this.updaterTask;
    this.watchDownloads();
    let failed = false;
    this.updaterTask = this.store.exclusive('updater-runner', async () => {
      while (!this.disposed && await this.coordinated(() => this.updaterStep())) { /* one source update boundary */ }
    }).catch(error => {
      failed = true; this.updaterFailure = error;
      recordBrowserDiagnosticError(error);
      for (const listener of this.listeners) listener();
    }).finally(() => {
      this.updaterTask = null;
      if (!failed) this.kickUpdater();
    });
    return this.updaterTask;
  }
  async updaterStep() {
    const state = normalizeUpdaterState(updaterState(this.db));
    if (state.state !== 'STARTED') return false;
    const row = state.queue.find(activeUpdaterJob);
    if (!row) { state.state = 'STOPPED'; await this.save(); return false; }
    try {
      const manga = this.find('mangas', row.mangaId);
      if (row.state === 'PENDING') {
        row.state = 'RUNNING'; row.tries = (row.tries || 0) + 1; delete row.error;
        await this.save(); return true;
      }
      const settings = this.localSettings();
      await this.fetchUpdate(manga.id, Boolean(settings.updateMangas) || !manga.initialized, true);
      row.state = 'COMPLETE'; delete row.error;
      if (!state.queue.some(activeUpdaterJob)) state.state = 'STOPPED';
      await this.save();
      return state.state === 'STARTED';
    } catch (error) {
      if (this.disposed) return false; // Leave a RUNNING checkpoint for a later tab.
      recordBrowserDiagnosticError(error);
      row.state = 'FAILED'; row.error = String(error.message || error).slice(0, 2000);
      if (!state.queue.some(activeUpdaterJob)) state.state = 'STOPPED';
      await this.save();
      return state.state === 'STARTED';
    }
  }
  async startLibraryUpdateOperation(input = {}, automated = false) {
    const requested = categoryIds(input.categories);
    const allCategories = [...this.db.categories];
    const selectedCategories = requested === null ? allCategories : allCategories.filter(category => requested.includes(category.id));
    const forceAll = requested !== null && requested.length > 0;
    const inclusion = category => typeof category.includeInUpdate === 'boolean'
      ? (category.includeInUpdate ? 'INCLUDE' : 'EXCLUDE') : (category.includeInUpdate || 'UNSET');
    const excludedCategories = selectedCategories.filter(category => inclusion(category) === 'EXCLUDE');
    const includedCategories = selectedCategories.filter(category => inclusion(category) === 'INCLUDE');
    const unsetCategories = selectedCategories.filter(category => inclusion(category) === 'UNSET');
    const categoriesToUpdate = forceAll ? selectedCategories : (includedCategories.length ? includedCategories : unsetCategories);
    const selectedIds = new Set(categoriesToUpdate.map(category => category.id));
    const excludedIds = new Set(excludedCategories.map(category => category.id));
    const settings = this.localSettings();
    const candidateMangas = [];
    const seen = new Set();
    for (const manga of this.db.mangas) {
      if (!manga.inLibrary || seen.has(manga.id)) continue;
      const mangaCategories = manga.categoryIds?.length ? manga.categoryIds : [0];
      if (!mangaCategories.some(id => selectedIds.has(id))) continue;
      seen.add(manga.id); candidateMangas.push(manga);
    }
    const skippedMangaIds = [];
    const eligible = candidateMangas.filter(manga => {
      const chapters = this.db.chapters.filter(chapter => chapter.mangaId === manga.id);
      const unread = chapters.filter(chapter => !chapter.isRead).length;
      const hasReadAt = manga.lastReadAt != null || chapters.some(chapter => chapter.lastReadAt != null && Number(chapter.lastReadAt) > 0);
      const completed = manga.status === 'COMPLETED' || manga.status === 2;
      const mangaCategories = manga.categoryIds?.length ? manga.categoryIds : [0];
      const shouldUpdate = (manga.updateStrategy || 'ALWAYS_UPDATE') === 'ALWAYS_UPDATE' &&
        (!settings.excludeUnreadChapters || unread === 0) &&
        (!manga.initialized || !settings.excludeNotStarted || hasReadAt) &&
        (!settings.excludeCompleted || !completed) &&
        (forceAll || !mangaCategories.some(id => excludedIds.has(id)));
      if (!shouldUpdate) skippedMangaIds.push(manga.id);
      return shouldUpdate;
    }).sort((a, b) => String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase()) || a.id - b.id);
    const state = normalizeUpdaterState(updaterState(this.db));
    state.state = eligible.length ? 'STARTED' : 'STOPPED';
    state.queue = eligible.map(manga => ({ mangaId: manga.id, state: 'PENDING', tries: 0 }));
    state.categoryUpdates = categoriesToUpdate.map(category => ({ categoryId: category.id, status: 'UPDATING' }));
    state.skippedCategoryIds = selectedCategories.filter(category => !selectedIds.has(category.id)).map(category => category.id);
    state.skippedMangaIds = skippedMangaIds;
    state.skippedCategoriesCount = selectedCategories.length - categoriesToUpdate.length;
    state.lastUpdateTimestamp = Date.now();
    if (automated) state.lastAutomatedUpdateTimestamp = Date.now();
    await this.save();
    return this.updaterStatus();
  }
  scheduleUpdater() {
    clearTimeout(this.updaterTimer); this.updaterTimer = null;
    if (!this.autoUpdates || this.disposed || !globalThis.document) return;
    const interval = Number(this.localSettings().globalUpdateInterval) * 60 * 60 * 1000;
    if (!Number.isFinite(interval) || interval <= 0) return;
    const state = normalizeUpdaterState(updaterState(this.db));
    const elapsed = Date.now() - (state.lastAutomatedUpdateTimestamp || 0);
    const delay = Math.max(0, interval - elapsed);
    this.updaterTimer = setTimeout(() => {
      this.updaterTimer = null;
      this.coordinated(async () => {
        const current = normalizeUpdaterState(updaterState(this.db));
        const currentInterval = Number(this.localSettings().globalUpdateInterval) * 60 * 60 * 1000;
        if (currentInterval > 0 && !updaterIsRunning(current) && Date.now() - (current.lastAutomatedUpdateTimestamp || 0) >= currentInterval) {
          current.lastAutomatedUpdateTimestamp = Date.now();
          await this.startLibraryUpdateOperation({}, true);
        }
      }).then(() => this.kickUpdater(), error => { this.updaterFailure = error; for (const listener of this.listeners) listener(); }).finally(() => this.scheduleUpdater());
    }, Math.min(delay, 2147483647));
  }
  find(list, id) { const record = (this.db[list] || []).find(item => String(item.id) === String(id)); if (!record) throw new Error(`${list} record ${id} does not exist`); return record; }
  async extensions() {
    const installed = await this.manager.list();
    const available = new Map();
    for (const repository of this.db.repositories) for (const entry of repository.extensions || []) {
      const old = available.get(entry.packageName);
      // Never silently change repositories for an installed package.
      const local = installed.find(record => record.packageName === entry.packageName);
      const owner = local?.storeIndexUrl;
      if (local && !owner) continue; // Manual imports have no repository trust association.
      if (owner && owner !== repository.indexUrl) continue;
      if (!old || BigInt(entry.versionCode) > BigInt(old.versionCode)) available.set(entry.packageName, {
        ...entry,
        storeIndexUrl: repository.indexUrl,
        repositoryFingerprint: repository.signingKey || '',
        repositoryName: repository.name || repository.badgeLabel || repository.indexUrl,
      });
    }
    return [...new Set([...available.keys(), ...installed.map(record => record.packageName)])].map(packageName => {
      const local = installed.find(record => record.packageName === packageName), remote = available.get(packageName);
      const record = local || remote;
      const storeIndexUrl = local?.storeIndexUrl || remote?.storeIndexUrl || null;
      return typed('ExtensionType', {
      pkgName: record.packageName, name: record.name, lang: new Set(record.sources.map(source => source.lang)).size === 1 ? record.sources[0].lang : 'all',
      versionCode: BigInt(record.versionCode || 0) <= 2147483647n ? Number(record.versionCode || 0) : null, versionCodeLong: String(record.versionCode || 0), versionName: record.version || '',
      extensionLib: record.libraryVersion, iconUrl: remote?.iconUrl || '', storeIndexUrl,
      extensionStore: this.db.repositories.find(repository => repository.indexUrl === storeIndexUrl) ? this.repository(this.db.repositories.find(repository => repository.indexUrl === storeIndexUrl)) : null,
      contentWarning: record.contentWarning || 'MIXED', isNsfw: record.contentWarning !== 'SAFE', isInstalled: !!local,
      isObsolete: !!local?.storeIndexUrl && !remote, hasUpdate: !!local && !!remote && BigInt(remote.versionCode) > BigInt(local.versionCode || 0),
    }); });
  }
  repository(record) {
    return typed('ExtensionStoreType', { ...record, extensions: args => this.extensions().then(extensions => connection('Extension', extensions.filter(extension => extension.storeIndexUrl === record.indexUrl), args)) });
  }
  extensionPermissionOrigins(packageName) {
    const origins = new Set();
    for (const repository of this.db.repositories || []) for (const entry of repository.extensions || []) {
      if (entry.packageName !== packageName) continue;
      for (const origin of artifactPermissionOrigins([entry.apkUrl, entry.jarUrl].filter(Boolean))) origins.add(origin);
      for (const origin of sourcePermissionOrigins(entry.sources || [])) origins.add(origin);
    }
    return [...origins].sort();
  }
  async installFromRepository(packageName, update = false) {
    const local = (await this.manager.list()).find(record => record.packageName === packageName);
    if (local && !local.storeIndexUrl && update) throw new Error('Manual imports cannot be silently adopted by a repository; uninstall and reinstall from a trusted repository first');
    const candidates = this.db.repositories.flatMap(repository => (repository.extensions || [])
      .filter(entry => entry.packageName === packageName && (!local?.storeIndexUrl || local.storeIndexUrl === repository.indexUrl))
      .map(entry => ({
        ...entry,
        storeIndexUrl: repository.indexUrl,
        repositoryFingerprint: repository.signingKey || '',
        repositoryName: repository.name || repository.badgeLabel || repository.indexUrl,
      })));
    candidates.sort((a, b) => BigInt(a.versionCode) > BigInt(b.versionCode) ? -1 : BigInt(a.versionCode) < BigInt(b.versionCode) ? 1 : 0);
    const entry = candidates[0];
    if (!entry) throw new Error('Extension is not available in the configured repositories');
    if (local && (!update || BigInt(entry.versionCode) <= BigInt(local.versionCode || 0))) return;
    const response = await this.transport({ url: entry.jarUrl || entry.apkUrl, method: 'GET', headers: [] });
    if (response.error || response.status < 200 || response.status >= 300) throw new Error('Extension download failed: ' + (response.error || 'HTTP ' + response.status));
    if (typeof response.body !== 'string' || response.body.length > Math.ceil(64 * 1024 * 1024 / 3) * 4) throw new Error('Extension download exceeds 64 MiB');
    await this.manager.install(new Blob([decodeBytes(response.body)]), {
      expectedPackage: packageName,
      expectedVersion: entry.versionCode,
      storeIndexUrl: entry.storeIndexUrl,
      repositoryFingerprint: entry.repositoryFingerprint,
      repositoryName: entry.repositoryName,
      manualImport: false,
    });
  }
  async source(id) {
    const value = (await this.manager.sources()).find(source => source.id === String(id));
    // Upstream's nullable Manga.source permits reading saved entries whose
    // extension is absent. Never fabricate an installed source for cached data.
    if (!value) return null;
    const extension = (await this.extensions()).find(extension => extension.pkgName === value.packageName);
    return typed('SourceType', { ...value, displayName: value.name, iconUrl: '', homeUrl: value.baseUrl, contentWarning: extension?.contentWarning || 'MIXED', isNsfw: extension?.contentWarning !== 'SAFE',
      isConfigurable: value.isConfigurable ?? (() => this.manager.call(value.id, 'capabilities').then(value => value.isConfigurable)),
      filters: () => this.manager.call(value.id, 'filters'), preferences: () => this.manager.call(value.id, 'preferences'), meta: this.db.sourceMeta.filter(meta => meta.sourceId === String(id)),
      extension,
    });
  }
  localTracker(args) {
    const records = this.db.trackRecords
      .filter(record => this.db.mangas.some(manga => String(manga.id) === String(record.mangaId)))
      .map(record => this.trackRecord(record));
    return typed('TrackerType', {
      id: LOCAL_TRACKER_ID, name: 'Local progress', icon: '', isLoggedIn: true, isTokenExpired: false, authUrl: null,
      supportsPrivateTracking: true, supportsReadingDates: true, supportsTrackDeletion: true,
      scores: [...LOCAL_TRACKER_SCORES], statuses: LOCAL_TRACKER_STATUSES.map(status => typed('TrackStatusType', status)),
      trackRecords: connection('TrackRecord', records, args),
    });
  }
  trackRecord(record) {
    const manga = this.find('mangas', record.mangaId);
    const chapters = this.db.chapters.filter(chapter => String(chapter.mangaId) === String(manga.id));
    const score = Number.isFinite(Number(record.score)) ? Number(record.score) : 0;
    const totalChapters = Number.isInteger(Number(record.totalChapters)) ? Number(record.totalChapters) : chapters.length;
    return typed('TrackRecordType', {
      id: Number(record.id), remoteId: String(record.remoteId ?? manga.id), trackerId: LOCAL_TRACKER_ID,
      remoteUrl: String(record.remoteUrl || manga.realUrl || manga.url || ''), title: String(record.title || manga.title || ''),
      status: Number.isInteger(Number(record.status)) ? Number(record.status) : 1,
      lastChapterRead: Number.isFinite(Number(record.lastChapterRead)) ? Number(record.lastChapterRead) : 0,
      totalChapters, score, displayScore: String(score),
      startDate: record.startDate == null ? UNSET_TRACK_DATE : String(record.startDate),
      finishDate: record.finishDate == null ? UNSET_TRACK_DATE : String(record.finishDate),
      private: record.private === true, libraryId: String(manga.id), mangaId: Number(manga.id),
      manga: () => this.manga(manga), tracker: () => this.localTracker(),
    });
  }
  trackRecordFor(id) {
    const record = this.db.trackRecords.find(record => String(record.id) === String(id));
    if (!record) throw new Error(`track record ${id} does not exist`);
    this.find('mangas', record.mangaId);
    return record;
  }
  assertLocalTracker(id) {
    if (Number(id) !== LOCAL_TRACKER_ID) throw new Error(`Tracker ${id} is not available in the browser-local backend`);
  }
  normalizeTrackDate(value, field) {
    if (value == null || value === UNSET_TRACK_DATE) return UNSET_TRACK_DATE;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return String(BigInt(value));
    // Accept the first experimental build's ISO dates during migration, but
    // store the GraphQL LongString representation expected by DateSetting.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      if (Number.isSafeInteger(timestamp)) return String(timestamp);
    }
    throw new TypeError(`${field} must be an epoch-millisecond LongString or 0`);
  }
  syncLocalTrackProgress(mangaId) {
    const chapters = this.db.chapters.filter(chapter => String(chapter.mangaId) === String(mangaId));
    // Tracker progress is the furthest completed chapter, matching the
    // monotonic progress expected by local and remote tracker UIs. A chapter
    // read in the same second as another must not be selected by timestamp
    // tie-breaking alone.
    const read = chapters.filter(chapter => chapter.isRead).sort((a, b) => {
      const aNumber = Number(a.chapterNumber ?? a.number), bNumber = Number(b.chapterNumber ?? b.number);
      return (Number.isFinite(bNumber) ? bNumber : Number(b.sourceOrder) || 0) - (Number.isFinite(aNumber) ? aNumber : Number(a.sourceOrder) || 0) || (b.sourceOrder || 0) - (a.sourceOrder || 0);
    });
    const latest = read[0];
    const latestNumber = latest ? Number(latest.chapterNumber ?? latest.number) : 0;
    const progress = Number.isFinite(latestNumber) && latestNumber >= 0 ? latestNumber : latest ? Number(latest.sourceOrder) || 0 : 0;
    const complete = chapters.length > 0 && read.length === chapters.length;
    const today = String(Date.now());
    const records = this.db.trackRecords.filter(record => String(record.mangaId) === String(mangaId));
    for (const record of records) {
      record.totalChapters = chapters.length;
      record.lastChapterRead = progress;
      if (progress > 0 && (record.startDate == null || record.startDate === UNSET_TRACK_DATE)) record.startDate = today;
      if (complete) {
        record.status = 3;
        if (record.finishDate == null || record.finishDate === UNSET_TRACK_DATE) record.finishDate = today;
      } else if (progress > 0) {
        record.status = 2;
        record.finishDate = UNSET_TRACK_DATE;
      }
    }
    return records.map(record => this.trackRecord(record));
  }
  searchLocalTracker(query) {
    const needle = String(query || '').trim().toLowerCase();
    return this.db.mangas
      .filter(manga => !needle || String(manga.title || '').toLowerCase().includes(needle))
      .map(manga => typed('TrackSearchType', {
        id: Number(manga.id), remoteId: String(manga.id), title: String(manga.title || ''),
        trackingUrl: String(manga.realUrl || manga.url || ''), coverUrl: String(manga.thumbnailUrl || ''),
        publishingType: 'manga', startDate: UNSET_TRACK_DATE, publishingStatus: 'releasing',
        summary: String(manga.description || ''), score: 0, displayScore: '0', totalChapters: this.db.chapters.filter(chapter => String(chapter.mangaId) === String(manga.id)).length,
        finishedReadingDate: UNSET_TRACK_DATE, lastChapterRead: 0, libraryId: String(manga.id), private: false,
        startedReadingDate: UNSET_TRACK_DATE, status: 1, trackerId: LOCAL_TRACKER_ID, tracker: () => this.localTracker(),
      }));
  }
  manga(record) {
    this.db.trackRecords ||= [];
    const chapters = this.db.chapters.filter(chapter => chapter.mangaId === record.id).sort((a, b) => b.sourceOrder - a.sourceOrder);
    const unread = chapters.filter(chapter => !chapter.isRead);
    const completed = chapters.filter(chapter => chapter.isRead); // sourceOrder descending
    // Upstream lastReadChapter ranks all chapters by activity (NULLS LAST),
    // including an unfinished chapter. latestReadChapter instead means the
    // highest source-order completed chapter, not the newest timestamp.
    const lastRead = [...chapters].sort((a, b) =>
      Number(a.lastReadAt == null) - Number(b.lastReadAt == null) ||
      (b.lastReadAt || 0) - (a.lastReadAt || 0) || b.sourceOrder - a.sourceOrder)[0];
    return withFilterValues(typed('MangaType', { author: null, artist: null, description: null, genre: [], status: 'UNKNOWN', initialized: false,
      inLibrary: false, inLibraryAt: 0, thumbnailUrl: '', thumbnailUrlLastFetched: 0, lastFetchedAt: 0, meta: [],
      ...record, updateStrategy: record.updateStrategy ?? 'ALWAYS_UPDATE', genre: (Array.isArray(record.genre) ? record.genre : typeof record.genre === 'string' ? record.genre.split(',') : []).filter(genre => typeof genre === 'string').map(genre => genre.trim()).filter(Boolean),
      thumbnailUrl: record.thumbnailUrl ? `/browser-local/manga/${record.id}/thumbnail` : '', realUrl: record.realUrl || record.url, chapters: args => connection('Chapter', chapters.map(chapter => this.chapter(chapter)), args),
      source: () => this.source(record.sourceId), categories: () => connection('Category', this.db.categories.filter(category => (record.categoryIds || [0]).includes(category.id)).map(category => this.category(category))),
      trackRecords: connection('TrackRecord', this.db.trackRecords.filter(trackRecord => String(trackRecord.mangaId) === String(record.id)).map(trackRecord => this.trackRecord(trackRecord))), unreadCount: unread.length,
      downloadCount: chapters.filter(chapter => chapter.isDownloaded).length, bookmarkCount: chapters.filter(chapter => chapter.isBookmarked).length, hasDuplicateChapters: false,
      firstUnreadChapter: unread.length ? this.chapter(unread.at(-1)) : null, lastReadChapter: lastRead ? this.chapter(lastRead) : null,
      latestReadChapter: completed.length ? this.chapter(completed[0]) : null, latestFetchedChapter: chapters.length ? this.chapter([...chapters].sort((a, b) => b.fetchedAt - a.fetchedAt)[0]) : null,
      latestUploadedChapter: chapters.length ? this.chapter([...chapters].sort((a,b) => b.uploadDate - a.uploadDate)[0]) : null,
      highestNumberedChapter: chapters.length ? this.chapter([...chapters].sort((a,b) => b.chapterNumber - a.chapterNumber)[0]) : null,
    }), {genre:record.browserGenreRaw??record.genre,thumbnailUrl:record.thumbnailUrl,realUrl:record.realUrl});
  }
  chapter(record) {
    return withFilterValues(typed('ChapterType', { pageCount: 0, isRead: false, isBookmarked: false, isDownloaded: false, lastPageRead: 0, lastReadAt: 0, meta: [], ...record,
      realUrl: record.realUrl || record.url, manga: () => this.manga(this.find('mangas', record.mangaId)),
    }), {realUrl:record.realUrl,inLibrary:this.find('mangas',record.mangaId).inLibrary??false});
  }
  category(record) {
    return typed('CategoryType', { ...categoryFields(record), meta: record.meta || [], mangas: args => connection('Manga', this.db.mangas.filter(manga => manga.inLibrary && (manga.categoryIds || [0]).includes(record.id)).map(manga => this.manga(manga)), args) });
  }
  rememberManga(sourceId, item, { details = false } = {}) {
    let record = this.db.mangas.find(manga => manga.sourceId === sourceId && manga.url === item.url);
    if (!record) { record = { id: this.db.nextId++, sourceId, url: item.url, title: item.title, inLibrary: false, categoryIds: [0], meta: [] }; this.db.mangas.push(record); }
    // Parsed detail pages can omit a cover already supplied by the list page.
    const thumbnailUrl = item.thumbnailUrl || record.thumbnailUrl;
    const update = { ...item };
    for (const field of ['author', 'artist', 'description', 'genre']) if (update[field] == null && record[field] != null) delete update[field];
    if (!details && record.initialized) {
      // List/search SManga objects usually contain only title and thumbnail;
      // their null defaults must not erase an already-fetched library record.
      for (const field of ['author', 'artist', 'description', 'genre']) if (update[field] == null) delete update[field];
      if (update.status === 0 || update.status === 'UNKNOWN') delete update.status;
      if (update.memo && !Object.keys(update.memo).length) delete update.memo;
      delete update.updateStrategy; // A list entry must not reset a saved detail policy.
    }
    Object.assign(record, update, { thumbnailUrl });
    if (typeof record.genre === 'string') { record.browserGenreRaw=record.genre;record.genre = record.genre.split(',').map(genre => genre.trim()); }
    if (typeof record.status === 'number') record.status = ['UNKNOWN', 'ONGOING', 'COMPLETED', 'LICENSED', 'PUBLISHING_FINISHED', 'CANCELLED', 'ON_HIATUS'][record.status] || 'UNKNOWN';
    return record;
  }
  async fetchDetails(id) {
    return (await this.fetchUpdate(id, true, false)).manga;
  }
  sourceChapters(mangaId) {
    return this.db.chapters.filter(chapter => chapter.mangaId === mangaId).sort((a, b) => b.sourceOrder - a.sourceOrder).map(chapter => ({
      url: chapter.url, name: chapter.name, number: chapter.number ?? chapter.chapterNumber,
      dateUpload: chapter.dateUpload ?? chapter.uploadDate, scanlator: chapter.scanlator, memo: chapter.memo,
    }));
  }
  async fetchChapters(id) {
    return (await this.fetchUpdate(id, false, true)).chapters;
  }
  async fetchUpdate(id, fetchDetails, fetchChapters) {
    const manga = this.find('mangas', id);
    if (!fetchDetails && !fetchChapters) return { manga: this.manga(manga), chapters: [] };
    const update = await this.manager.call(manga.sourceId, 'update', { manga, knownChapters: this.sourceChapters(manga.id), fetchDetails, fetchChapters });
    if (!update?.manga || !Array.isArray(update.chapters)) throw new Error('Source returned an invalid combined update');
    // Validate the chapter response before committing either half of an update.
    if (fetchChapters) uniqueSourceChapters(update.chapters);
    const chapters = fetchChapters ? await this.rememberChapters(manga, update.chapters) : [];
    if (fetchDetails) {
      this.rememberManga(manga.sourceId, { ...update.manga, url: manga.url }, { details: true });
      Object.assign(manga, { initialized: true, lastFetchedAt: epoch() });
    }
    return { manga: this.manga(manga), chapters };
  }
  async rememberChapters(manga, items) {
    // Match Chapter.processChapterList: work oldest first for missing upload
    // dates, and retain fetchedAt for existing URLs. Never copy local reader,
    // cache, or identity fields from an extension's result object.
    const now = Date.now();
    const fetchedAt = Math.floor(now / 1000);
    const unique = uniqueSourceChapters(items);
    // Like the server, treat an empty catalogue as a failed refresh rather
    // than retiring an entire library after a source/parser/network failure.
    if (!unique.length) throw new Error('No chapters found');
    const previous = this.db.chapters.filter(chapter => chapter.mangaId === manga.id);
    const urls = new Set(unique.map(item => item.url));
    const removed = previous.filter(chapter => !urls.has(chapter.url));
    const byNumber = new Map(removed.filter(chapter => chapter.chapterNumber >= 0).map(chapter => [chapter.chapterNumber, chapter]));
    const downloadsByNumber = new Map(removed.filter(chapter => chapter.isDownloaded).map(chapter => [chapter.chapterNumber, chapter]));
    let nextId = this.db.nextId;
    let maxSeenUploadDate = 0;
    const result = [];
    for (let index = unique.length - 1; index >= 0; index--) {
      const item = unique[index];
      const existing = previous.find(chapter => chapter.url === item.url);
      const isNew = !existing;
      const chapter = existing ? { ...existing } : { id: nextId++, mangaId: manga.id, fetchedAt };
      const replaced = isNew && item.number >= 0 ? byNumber.get(item.number) : null;
      if (replaced) {
        chapter.fetchedAt = replaced.fetchedAt;
        for (const key of ['isRead', 'isBookmarked', 'lastPageRead', 'lastReadAt']) if (replaced[key] !== undefined) chapter[key] = replaced[key];
      }
      // Browser equivalent of moving a preserved download directory. Copy only
      // validated blobs to the new ID; never alias mutable cache keys belonging
      // to a retired record. Read state and shared downloads have separate maps.
      const downloaded = isNew ? downloadsByNumber.get(item.number) : null;
      if (downloaded && (downloaded.scanlator ?? null) === (item.scanlator ?? null)) {
        const cached = await this.cachedChapterPages(downloaded);
        if (cached.length && cached.every(Boolean)) {
          for (let page = 0; page < cached.length; page++) {
            await this.store.put('settings', { ...cached[page], key: `webui:page:${chapter.id}:${page}` });
          }
          chapter.pages = structuredClone(downloaded.pages);
          chapter.pageCount = downloaded.pageCount;
          chapter.isDownloaded = true;
        }
      }
      let uploadDate = item.dateUpload || 0;
      if (!uploadDate) uploadDate = isNew ? (maxSeenUploadDate || now) : chapter.uploadDate;
      else if (isNew) maxSeenUploadDate = Math.max(maxSeenUploadDate, uploadDate);
      // Suwayomi numbers source order from oldest=1; its reader indexes by it.
      Object.assign(chapter, {
        url: item.url, name: item.name, number: item.number, dateUpload: uploadDate,
        scanlator: item.scanlator, memo: item.memo, realUrl: item.realUrl,
        sourceOrder: unique.length - index, chapterNumber: item.number, uploadDate,
      });
      result.unshift(chapter);
    }
    // Keep a recoverable local archive rather than destroying removed chapters
    // and downloaded blobs. The active catalogue still matches the source.
    this.db.archivedChapters = [...(this.db.archivedChapters || []), ...removed.map(chapter => ({ ...chapter, sourceRemovedAt: fetchedAt }))];
    this.db.chapters = [...this.db.chapters.filter(chapter => chapter.mangaId !== manga.id), ...result];
    this.db.nextId = nextId;
    manga.chaptersLastFetchedAt = fetchedAt;
    await this.enqueueAutoDownloadChapters(manga, previous, result);
    return result.map(chapter => this.chapter(chapter));
  }
  downloadCategoryIncluded(manga) {
    const inclusion = category => typeof category.includeInDownload === 'boolean'
      ? (category.includeInDownload ? 'INCLUDE' : 'EXCLUDE') : (category.includeInDownload || 'UNSET');
    const categoryIds = manga.categoryIds?.length ? manga.categoryIds : [0];
    const categories = this.db.categories.filter(category => categoryIds.includes(category.id));
    const included = this.db.categories.filter(category => inclusion(category) === 'INCLUDE');
    const unset = this.db.categories.filter(category => inclusion(category) === 'UNSET');
    const allowed = included.length ? included : unset;
    return !categories.some(category => inclusion(category) === 'EXCLUDE') &&
      categories.some(category => allowed.some(candidate => candidate.id === category.id));
  }
  async enqueueAutoDownloadChapters(manga, previous, current) {
    const settings = this.localSettings();
    if (!settings.autoDownloadNewChapters || previous.length === 0 || !current.length || !this.downloadCategoryIncluded(manga)) return [];
    const previousUrls = new Set(previous.map(chapter => chapter.url));
    const newChapters = current.filter(chapter => !previousUrls.has(chapter.url));
    if (!newChapters.length) return [];
    const newIds = new Set(newChapters.map(chapter => chapter.id));
    const hasUnreadExisting = this.db.chapters.some(chapter => chapter.mangaId === manga.id && !newIds.has(chapter.id) && !chapter.isRead);
    if (settings.excludeEntryWithUnreadChapters && hasUnreadExisting) return [];

    const previousLatest = [...previous]
      .sort((a, b) => (b.sourceOrder || 0) - (a.sourceOrder || 0) || b.id - a.id)[0];
    const previousLatestNumber = Number(previousLatest?.chapterNumber ?? previousLatest?.number);
    const actualNew = settings.autoDownloadIgnoreReUploads && Number.isFinite(previousLatestNumber)
      ? newChapters.filter(chapter => Number(chapter.chapterNumber ?? chapter.number) >= previousLatestNumber)
      : newChapters;
    if (!actualNew.length) return [];

    // Match Chapter.removeDuplicates: choose one representative per chapter
    // number for the limit, then enqueue every scanlator/variant with a chosen
    // number. The first source-order item is the upstream pivot.
    const pivot = actualNew[0];
    const groups = new Map();
    for (const chapter of actualNew) {
      const number = String(chapter.chapterNumber ?? chapter.number);
      if (!groups.has(number)) groups.set(number, []);
      groups.get(number).push(chapter);
    }
    const representatives = [...groups.values()]
      .map(group => group.find(chapter => chapter.id === pivot.id) ||
        group.find(chapter => (chapter.scanlator ?? null) === (pivot.scanlator ?? null)) || group[0])
      .sort((a, b) => (a.sourceOrder || 0) - (b.sourceOrder || 0) || a.id - b.id);
    const limit = Number(settings.autoDownloadNewChaptersLimit);
    const selected = representatives.slice(0, limit === 0 ? representatives.length : Math.max(0, Math.min(limit, representatives.length)));
    const selectedNumbers = new Set(selected.map(chapter => String(chapter.chapterNumber ?? chapter.number)));
    const ids = [...new Set(newChapters.filter(chapter => selectedNumbers.has(String(chapter.chapterNumber ?? chapter.number))).map(chapter => chapter.id))];
    if (!ids.length) return [];

    const downloads = queueState(this.db);
    const records = ids.map(id => this.find('chapters', id)).sort((a, b) => a.mangaId - b.mangaId || (a.sourceOrder || 0) - (b.sourceOrder || 0) || a.id - b.id);
    const cached = await Promise.all(records.map(chapter => this.cachedChapterPages(chapter)));
    let added = false;
    records.forEach((chapter, index) => {
      chapter.isDownloaded = cached[index].length > 0 && cached[index].every(Boolean);
      if (chapter.isDownloaded) return;
      let row = downloads.queue.find(item => item.chapterId === chapter.id);
      if (!row) {
        row = { chapterId: chapter.id, state: 'QUEUED', progress: 0, tries: 0 };
        downloads.queue.push(row); added = true;
      } else if (row.state === 'ERROR') {
        row.state = 'QUEUED'; row.error = null; row.progress = 0; added = true;
      }
    });
    if (added) {
      downloads.state = 'STARTED';
      this.watchDownloads();
    }
    return records.filter((_, index) => !cached[index].length || !cached[index].every(Boolean)).map(chapter => chapter.id);
  }
  coordinated(task) {
    const result = this.mutations.then(() => this.store.exclusive('webui', async () => {
      await this.loading;
      // A second tab may have committed since this instance last read the DB.
      await this.load();
      return task();
    }));
    this.mutations = result.catch(() => {});
    return result;
  }
  resolve(name, args = {}) {
    const result = this.coordinated(() => this.resolveOperation(name, args));
    result.then(() => { this.kickDownloads(); this.kickUpdater(); }, error => {
      recordBrowserDiagnosticError(error, [...collectStrings(args), ...libraryPrivateStrings(this.db)]);
    });
    return result;
  }
  async cachedChapterPages(chapter) {
    return Promise.all((chapter.pages || []).map(async (page, index) => {
      const stored = await this.store.get('settings', `webui:page:${chapter.id}:${index}`);
      return stored?.blob instanceof Blob && stored.blob.size > 0 && stored.remoteUrl === JSON.stringify([page.url, page.imageUrl]) ? stored : null;
    }));
  }
  async refreshPageManifest(chapter) {
    const manga = this.find('mangas', chapter.mangaId);
    const pages = await this.manager.call(manga.sourceId, 'pages', { chapter });
    if (!Array.isArray(pages) || !pages.length) throw new Error('Source returned no chapter pages');
    chapter.pages = pages; chapter.pageCount = pages.length;
    delete chapter.browserPagesNeedRefresh;
  }
  async resolveOperation(name, args = {}) {
    await this.loading;
    const input = args.input || args;
    const metadataOperation = /^(set|delete)(Manga|Chapter|Category|Source)Metas$/.exec(name);
    if (metadataOperation) {
      const [, action, entity] = metadataOperation;
      const scope = entity.toLowerCase();
      const collection = scope === 'category' ? 'categories' : scope + 's';
      const idKey = scope + 'Id';
      const idList = scope + 'Ids';
      if (action === 'set') for (const item of input.items) for (const meta of item.metas) {
        if (typeof meta.key !== 'string' || typeof meta.value !== 'string') throw new Error('Metadata requires string keys and values');
      }
      const parents = [], metas = [];
      for (const item of input.items) for (const id of item[idList]) {
        const parent = scope === 'source' ? { id, meta: this.db.sourceMeta.filter(meta => meta.sourceId === id) } : this.find(collection, id);
        parent.meta ||= [];
        if (action === 'set') {
          const updated = item.metas.map(meta => typed(entity + 'MetaType', { ...meta, [idKey]: id }));
          parent.meta = parent.meta.filter(old => !updated.some(meta => meta.key === old.key)).concat(updated);
          metas.push(...updated);
        } else {
          const removed = parent.meta.filter(meta => item.keys?.includes(meta.key) || item.prefixes?.some(prefix => meta.key.startsWith(prefix)));
          parent.meta = parent.meta.filter(meta => !removed.includes(meta));
          metas.push(...removed);
        }
        if (scope === 'source') this.db.sourceMeta = this.db.sourceMeta.filter(meta => meta.sourceId !== id).concat(parent.meta);
        parents.push(scope === 'source' ? await this.source(id) : scope === 'manga' ? this.manga(parent) : scope === 'chapter' ? this.chapter(parent) : this.category(parent));
      }
      await this.save();
      return { metas, [collection]: parents };
    }
    switch (name) {
      case 'browserArchivedChapters': return (this.db.archivedChapters || []).map(chapter => ({ ...chapter, mangaTitle: this.find('mangas', chapter.mangaId).title }));
      case 'browserRestoreArchivedChapters': {
        if (!Array.isArray(input.ids)) throw new TypeError('Archived chapter IDs are required');
        const records = input.ids.map(id => this.find('archivedChapters', id));
        const keys = new Set(this.db.chapters.map(chapter => JSON.stringify([chapter.mangaId, chapter.url])));
        for (const record of records) {
          const key = JSON.stringify([record.mangaId, record.url]);
          if (keys.has(key)) throw new Error('An active chapter already has this URL');
          keys.add(key);
        }
        const ids = new Set(records.map(chapter => chapter.id));
        this.db.chapters.push(...records.map(({ sourceRemovedAt, ...chapter }) => chapter));
        this.db.archivedChapters = this.db.archivedChapters.filter(chapter => !ids.has(chapter.id));
        for (const mangaId of new Set(records.map(chapter => chapter.mangaId))) {
          this.db.chapters.filter(chapter => chapter.mangaId === mangaId).sort((a, b) => a.sourceOrder - b.sourceOrder || a.id - b.id).forEach((chapter, index) => { chapter.sourceOrder = index + 1; });
        }
        await this.save();
        return { restored: records.length };
      }
      case 'aboutServer': return typed('AboutServer', { name: 'Suwayomi Browser (local)', version: this.version, buildType: 'BROWSER', buildTime: 0, discord: 'https://discord.gg/suwayomi', github: 'https://github.com/Suwayomi/Suwayomi-Server', platformInfo: { os: { name: 'Browser', build: '', version: '' }, arch: 'wasm32', headless: false, jvm: { javaVersion: '23', vmName: 'Bovine WASM JVM', vmVendor: 'b-jvm', vmVersion: 'local' } } });
      case 'aboutWebUI': return typed('AboutWebUI', { channel: 'BUNDLED', tag: 'r3541', updateTimestamp: 0 });
      case 'checkForServerUpdates': return [];
      case 'checkForWebUIUpdate': return typed('WebUIUpdateCheck', { channel: 'BUNDLED', tag: 'r3541', updateAvailable: false });
      case 'getWebUIUpdateStatus': case 'resetWebUIUpdateStatus': return typed('WebUIUpdateStatus', {
        info: typed('WebUIUpdateInfo', { channel: 'BUNDLED', tag: 'r3541' }), progress: 0, state: 'IDLE',
      });
      case 'createBackup': return this.createBrowserBackup(input || {});
      case 'validateBackup': return this.validateBrowserBackup(input?.backup);
      case 'restoreBackup': return this.restoreBrowserBackup(input || {});
      case 'restoreStatus': return this.browserRestoreStatus(input.id);
      case 'settings': return this.settingsPayload();
      case 'setSettings': {
        const patch = input.settings;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Settings patch required');
        const supported = new Set(['updateMangas', 'excludeUnreadChapters', 'excludeNotStarted', 'excludeCompleted', 'autoDownloadNewChapters', 'excludeEntryWithUnreadChapters', 'autoDownloadNewChaptersLimit', 'autoDownloadIgnoreReUploads', 'globalUpdateInterval']);
        for (const key of Object.keys(patch)) if (!supported.has(key)) unsupported('server setting ' + key);
        for (const key of ['updateMangas', 'excludeUnreadChapters', 'excludeNotStarted', 'excludeCompleted', 'autoDownloadNewChapters', 'excludeEntryWithUnreadChapters', 'autoDownloadIgnoreReUploads']) {
          if (patch[key] != null && typeof patch[key] !== 'boolean') throw new TypeError(key + ' must be boolean');
        }
        if (patch.autoDownloadNewChaptersLimit != null && (!Number.isInteger(patch.autoDownloadNewChaptersLimit) || patch.autoDownloadNewChaptersLimit < 0)) {
          throw new TypeError('autoDownloadNewChaptersLimit must be a non-negative integer');
        }
        if (patch.globalUpdateInterval != null && (!Number.isFinite(patch.globalUpdateInterval) || patch.globalUpdateInterval < 0)) {
          throw new TypeError('globalUpdateInterval must be a non-negative number');
        }
        Object.assign(this.db.settings, patch);
        await this.save(); this.scheduleUpdater();
        return { clientMutationId: input.clientMutationId ?? null, settings: this.settingsPayload() };
      }
      case 'resetSettings': {
        this.db.settings = {};
        await this.save(); this.scheduleUpdater();
        return { clientMutationId: input.clientMutationId ?? null, settings: this.settingsPayload() };
      }
      case 'meta': { const meta = this.db.meta.find(meta => meta.key === args.key); return meta ? { ...meta, __typename: 'GlobalMetaType' } : null; }
      case 'metas': return connection('GlobalMeta', this.db.meta.map(meta => ({ ...meta, __typename: 'GlobalMetaType' })), args);
      case 'setGlobalMetas': {
        const metas = input.metas.map(meta => {
          if (typeof meta.key !== 'string' || typeof meta.value !== 'string') throw new Error('Metadata requires string keys and values');
          return typed('GlobalMetaType', meta);
        });
        this.db.meta = this.db.meta.filter(old => !metas.some(meta => meta.key === old.key)).concat(metas);
        await this.save(); return { metas };
      }
      case 'deleteGlobalMetas': {
        const removed = this.db.meta.filter(meta => input.keys.includes(meta.key));
        this.db.meta = this.db.meta.filter(meta => !input.keys.includes(meta.key));
        await this.save(); return { metas: removed };
      }
      case 'categories': return connection('Category', this.db.categories.map(category => this.category(category)), args);
      case 'category': return this.category(this.find('categories', args.id));
      case 'createCategory': case 'updateCategory': case 'updateCategories': case 'updateCategoryOrder': case 'deleteCategory': {
        const result = mutateCategories(this.db, name, input);
        await this.save();
        return { ...result,
          ...('category' in result ? { category: result.category ? this.category(result.category) : null } : {}),
          ...(result.categories ? { categories: result.categories.map(category => this.category(category)) } : {}),
          ...(result.mangas ? { mangas: result.mangas.map(manga => this.manga(manga)) } : {}),
        };
      }
      case 'sources': return connection('Source', await Promise.all((await this.manager.sources()).map(source => this.source(source.id))), args);
      case 'source': return this.source(args.id);
      case 'updateSourcePreference': {
        const preferences = await this.manager.call(String(input.source), 'preference', { change: input.change });
        return { preferences, source: await this.source(input.source) };
      }
      case 'extensions': return connection('Extension', await this.extensions(), args);
      case 'fetchExtensions': {
        const refreshed = [];
        for (const repository of this.db.repositories) {
          const current = await fetchRepository(repository.indexUrl, this.transport);
          if (current.signingKey !== repository.signingKey) throw new Error('Repository signing identity changed; remove and re-add it only if you trust the new identity');
          refreshed.push(current);
        }
        this.db.repositories = refreshed; await this.save();
        return { extensions: await this.extensions(), extensionStores: this.db.repositories.map(record => this.repository(record)) };
      }
      case 'extensionStores': return connection('ExtensionStore', this.db.repositories.map(record => this.repository(record)), args);
      case 'extensionStore': { const repository = this.db.repositories.find(record => record.indexUrl === args.indexUrl); return repository ? this.repository(repository) : null; }
      case 'addExtensionStore': {
        const repository = await fetchRepository(input.indexUrl, this.transport);
        const existing = this.db.repositories.find(record => record.indexUrl === repository.indexUrl);
        if (existing && existing.signingKey !== repository.signingKey) throw new Error('Repository signing identity changed');
        this.db.repositories = this.db.repositories.filter(record => record.indexUrl !== repository.indexUrl).concat(repository);
        await this.save(); return { extensionStore: this.repository(repository) };
      }
      case 'removeExtensionStore': {
        const indexUrl = repositoryUrl(input.indexUrl);
        const repository = this.db.repositories.find(record => record.indexUrl === indexUrl);
        this.db.repositories = this.db.repositories.filter(record => record.indexUrl !== indexUrl);
        await this.save(); return { extensionStore: repository ? this.repository(repository) : null };
      }
      case 'updateExtension': case 'updateExtensions': {
        const ids = name === 'updateExtension' ? [input.id] : input.ids;
        const actions = ['install', 'update', 'uninstall'].filter(action => input.patch?.[action] === true);
        if (actions.length !== 1 || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Specify one extension action and valid package IDs');
        for (const id of ids) {
          if (actions[0] === 'uninstall') await this.manager.uninstall(id);
          else await this.installFromRepository(id, actions[0] === 'update');
        }
        const extensions = (await this.extensions()).filter(extension => ids.includes(extension.pkgName));
        return name === 'updateExtension' ? { extension: extensions[0] || null } : { extensions };
      }
      case 'installExternalExtension': { const record = await this.manager.install(input.extensionFile); return { extension: (await this.extensions()).find(extension => extension.pkgName === record.packageName) }; }
      case 'fetchSourceManga': {
        const operation = input.type === 'LATEST' ? 'latest' : input.type === 'SEARCH' ? 'search' : 'popular';
        if (operation !== 'search' && input.filters?.length) throw new Error('Source filters require a SEARCH request');
        const result = await this.manager.call(String(input.source), operation, { page: input.page, query: input.query, filters: input.filters });
        const mangas = result.mangas.map(item => this.rememberManga(String(input.source), item));
        await this.save(); return { hasNextPage: result.hasNextPage, mangas: mangas.map(manga => this.manga(manga)) };
      }
      case 'mangas': return connection('Manga', this.db.mangas.map(manga => this.manga(manga)), args);
      case 'manga': return this.manga(this.find('mangas', args.id));
      case 'chapter': return this.chapter(this.find('chapters', args.id));
      case 'chapters': return connection('Chapter', this.db.chapters.map(chapter => this.chapter(chapter)), args);
      case 'trackRecords': return connection('TrackRecord', this.db.trackRecords.filter(record => this.db.mangas.some(manga => String(manga.id) === String(record.mangaId))).map(record => this.trackRecord(record)), args);
      case 'fetchManga': { const manga = await this.fetchDetails(input.id); await this.save(); return { manga }; }
      case 'fetchChapters': { const chapters = await this.fetchChapters(input.mangaId); await this.save(); return { chapters }; }
      case 'fetchMangaAndChapters': {
        const update = await this.fetchUpdate(input.id, !!input.fetchManga, !!input.fetchChapters);
        await this.save(); return update;
      }
      case 'updateMangaCategories': case 'updateMangasCategories': {
        const single = name === 'updateMangaCategories';
        const records = (single ? [input.id] : input.ids).map(id => this.find('mangas', id));
        const patch = input.patch || {};
        for (const key of Object.keys(patch)) {
          if (!['clearCategories', 'addToCategories', 'removeFromCategories'].includes(key)) unsupported('category patch ' + key);
        }
        if (patch.clearCategories != null && typeof patch.clearCategories !== 'boolean') throw new TypeError('clearCategories must be boolean');
        const additions = patch.addToCategories || [], removals = patch.removeFromCategories || [];
        for (const ids of [additions, removals]) {
          if (!Array.isArray(ids) || !ids.every(Number.isInteger)) throw new TypeError('Category IDs must be integer arrays');
        }
        for (const id of additions) this.find('categories', id);
        // Category zero is implicit: no explicit mappings means Default.
        // Match upstream ordering: clear/remove first, then add (deduplicated).
        const updates = records.map(manga => {
          const ids = new Set(patch.clearCategories ? [] : (manga.categoryIds || []).filter(id => id !== 0 && !removals.includes(id)));
          for (const id of additions) if (id !== 0) ids.add(id);
          return ids.size ? [...ids] : [0];
        });
        records.forEach((manga, index) => { manga.categoryIds = updates[index]; });
        await this.save();
        const payload = { clientMutationId: input.clientMutationId ?? null };
        return single ? { ...payload, manga: this.manga(records[0]) } : { ...payload, mangas: records.map(manga => this.manga(manga)) };
      }
      case 'updateManga': case 'updateMangas': {
        const records = (name === 'updateManga' ? [input.id] : input.ids).map(id => this.find('mangas', id));
        for (const [key, value] of Object.entries(input.patch)) {
          if (key !== 'inLibrary') unsupported('manga patch ' + key);
          if (typeof value !== 'boolean') throw new TypeError('inLibrary must be boolean');
        }
        for (const manga of records) {
          if (input.patch.inLibrary && !manga.inLibrary) manga.inLibraryAt = epoch();
          Object.assign(manga, input.patch);
        }
        await this.save();
        return name === 'updateManga' ? { manga: this.manga(records[0]) } : { mangas: records.map(manga => this.manga(manga)) };
      }
      case 'updateChapter': case 'updateChapters': {
        const records = (name === 'updateChapter' ? [input.id] : input.ids).map(id => this.find('chapters', id));
        for (const [key, value] of Object.entries(input.patch)) {
          if (key === 'lastPageRead') {
            if (!Number.isInteger(value) || value < 0) throw new TypeError('lastPageRead must be a nonnegative integer');
          } else if (key === 'isRead' || key === 'isBookmarked') {
            if (typeof value !== 'boolean') throw new TypeError(key + ' must be boolean');
          } else unsupported('chapter patch ' + key);
        }
        for (const chapter of records) {
          Object.assign(chapter, input.patch);
          if (input.patch.isRead || input.patch.lastPageRead != null) chapter.lastReadAt = epoch();
          if (chapter.pageCount) chapter.lastPageRead = Math.min(chapter.lastPageRead || 0, chapter.pageCount - 1);
        }
        await this.save();
        return name === 'updateChapter' ? { chapter: this.chapter(records[0]) } : { chapters: records.map(chapter => this.chapter(chapter)) };
      }
      case 'fetchChapterPages': {
        const chapter = this.find('chapters', input.chapterId), manga = this.find('mangas', chapter.mangaId);
        let cached = await this.cachedChapterPages(chapter);
        chapter.isDownloaded = cached.length > 0 && cached.every(Boolean);
        if (!chapter.isDownloaded) {
          if (await this.source(manga.sourceId)) await this.refreshPageManifest(chapter);
          else if (!chapter.pages?.length) throw new Error(`Source ${manga.sourceId} is not installed and this chapter has no cached page manifest`);
          // A missing source cannot refresh a known manifest. Retain its local
          // pages, including partial downloads, rather than hiding cached data.
        }
        cached = await this.cachedChapterPages(chapter);
        chapter.isDownloaded = cached.length > 0 && cached.every(Boolean);
        chapter.pageCount = chapter.pages.length;
        if (!chapter.isDownloaded) await this.preparePagePermissions(chapter.pages.filter((_, index) => !cached[index]));
        await this.save(); return { chapter: this.chapter(chapter), pages: chapter.pages.map((_, index) => `/browser-local/chapter/${chapter.id}/page/${index}`) };
      }
      case 'downloadStatus': this.watchDownloads(); return this.downloadStatus();
      case 'downloadStatusChanged': {
        this.watchDownloads();
        const status = this.downloadStatus();
        const updates = status.queue.map(download => typed('DownloadUpdate', { type: download.state === 'ERROR' ? 'ERROR' : 'PROGRESS', download }));
        // The local link supplies the previous subscriber snapshot, allowing
        // lossless removals even if many page commits occur during projection.
        for (const id of args.knownChapterIds || []) if (!status.queue.some(row => row.chapter.id === id)) {
          const chapter = this.db.chapters.find(chapter => chapter.id === id) || this.db.archivedChapters?.find(chapter => chapter.id === id);
          if (chapter) updates.push(typed('DownloadUpdate', { type: chapter.isDownloaded ? 'FINISHED' : 'DEQUEUED', download: this.downloadItem({ chapterId: id, state: chapter.isDownloaded ? 'FINISHED' : 'QUEUED', progress: chapter.isDownloaded ? 1 : 0, tries: 0 }, -1) }));
        }
        return typed('DownloadUpdates', { state: status.state, updates, initial: args.knownChapterIds === undefined ? status.queue : null, currentChapterIds: status.queue.map(download => download.chapter.id), omittedUpdates: false });
      }
      case 'enqueueChapterDownload': case 'enqueueChapterDownloads': {
        const records = chapterIds(input, name === 'enqueueChapterDownload').map(id => this.find('chapters', id)).sort((a, b) => a.mangaId - b.mangaId || a.sourceOrder - b.sourceOrder || a.id - b.id);
        const cached = await Promise.all(records.map(chapter => this.cachedChapterPages(chapter)));
        const downloads = queueState(this.db); let added = false;
        records.forEach((chapter, index) => {
          chapter.isDownloaded = cached[index].length > 0 && cached[index].every(Boolean);
          if (chapter.isDownloaded) return;
          let row = downloads.queue.find(row => row.chapterId === chapter.id);
          if (!row) { row = { chapterId: chapter.id, state: 'QUEUED', progress: 0, tries: 0 }; downloads.queue.push(row); added = true; }
          else if (row.state === 'ERROR') { row.state = 'QUEUED'; row.error = null; row.progress = 0; added = true; }
        });
        if (added) downloads.state = 'STARTED';
        this.watchDownloads(); await this.save(); return { clientMutationId: input.clientMutationId ?? null, downloadStatus: this.downloadStatus() };
      }
      case 'dequeueChapterDownload': case 'dequeueChapterDownloads': {
        const ids = chapterIds(input, name === 'dequeueChapterDownload');
        const downloads = queueState(this.db); downloads.queue = downloads.queue.filter(row => !ids.includes(row.chapterId));
        if (!downloads.queue.some(row => row.state !== 'ERROR')) downloads.state = 'STOPPED';
        await this.save(); return { clientMutationId: input.clientMutationId ?? null, downloadStatus: this.downloadStatus() };
      }
      case 'startDownloader': case 'stopDownloader': case 'clearDownloader': {
        const downloads = queueState(this.db);
        downloads.state = name === 'startDownloader' && downloads.queue.length ? 'STARTED' : 'STOPPED';
        if (name === 'clearDownloader') downloads.queue = [];
        else for (const row of downloads.queue) {
          if ((name === 'startDownloader' && row.state === 'ERROR') || (name === 'stopDownloader' && row.state === 'DOWNLOADING')) { row.state = 'QUEUED'; row.error = null; }
        }
        await this.save(); return { clientMutationId: input.clientMutationId ?? null, downloadStatus: this.downloadStatus() };
      }
      case 'reorderChapterDownload': case 'reorderChapterDownloads': {
        const downloads = queueState(this.db);
        downloads.queue = reorderDownloads(downloads.queue, name === 'reorderChapterDownload' ? [{ chapterId: input.chapterId, to: input.to }] : input.reorders);
        await this.save(); return { clientMutationId: input.clientMutationId ?? null, downloadStatus: this.downloadStatus() };
      }
      case 'deleteDownloadedChapter': case 'deleteDownloadedChapters': {
        const single = name === 'deleteDownloadedChapter';
        const ids = chapterIds(input, single), records = ids.map(id => this.find('chapters', id));
        const keys = (await Promise.all(ids.map(id => this.store.getKeysByPrefix('settings', `webui:page:${id}:`)))).flat();
        const downloads = queueState(this.db); downloads.queue = downloads.queue.filter(row => !ids.includes(row.chapterId));
        if (!downloads.queue.some(row => row.state !== 'ERROR')) downloads.state = 'STOPPED';
        for (const key of keys) await this.store.delete('settings', key);
        for (const chapter of records) chapter.isDownloaded = false;
        await this.save(); return { clientMutationId: input.clientMutationId ?? null, chapters: single ? this.chapter(records[0]) : records.map(chapter => this.chapter(chapter)) };
      }
      case 'updateLibrary': {
        const updateStatus = await this.startLibraryUpdateOperation(input);
        return { clientMutationId: input.clientMutationId ?? null, updateStatus };
      }
      case 'updateLibraryManga': {
        const updateStatus = await this.startLibraryUpdateOperation({ categories: null });
        return { clientMutationId: input.clientMutationId ?? null, updateStatus: this.legacyUpdateStatus(updateStatus) };
      }
      case 'updateCategoryManga': {
        const updateStatus = await this.startLibraryUpdateOperation(input);
        return { clientMutationId: input.clientMutationId ?? null, updateStatus: this.legacyUpdateStatus(updateStatus) };
      }
      case 'updateStop': {
        clearUpdater(normalizeUpdaterState(updaterState(this.db)));
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null };
      }
      case 'libraryUpdateStatus': return this.updaterStatus();
      case 'libraryUpdateStatusChanged': { this.watchDownloads(); return this.updaterUpdates(); }
      case 'lastUpdateTimestamp': return { timestamp: normalizeUpdaterState(updaterState(this.db)).lastUpdateTimestamp };
      case 'searchTracker': {
        this.assertLocalTracker(input.trackerId);
        return { trackSearches: this.searchLocalTracker(input.query) };
      }
      case 'trackers': return connection('Tracker', [this.localTracker()], args);
      case 'trackProgress': {
        const mangaId = Number(input.mangaId);
        if (!Number.isInteger(mangaId)) throw new TypeError('mangaId must be an integer');
        this.find('mangas', mangaId);
        const trackRecords = this.syncLocalTrackProgress(mangaId);
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecords };
      }
      case 'bindTrack': {
        this.assertLocalTracker(input.trackerId);
        const mangaId = Number(input.mangaId);
        if (!Number.isInteger(mangaId)) throw new TypeError('mangaId must be an integer');
        const manga = this.find('mangas', mangaId);
        const remoteId = String(input.remoteId ?? '');
        if (!remoteId) throw new TypeError('remoteId is required');
        if (input.private != null && typeof input.private !== 'boolean') throw new TypeError('private must be boolean');
        let record = this.db.trackRecords.find(candidate => String(candidate.mangaId) === String(manga.id) && Number(candidate.trackerId ?? LOCAL_TRACKER_ID) === LOCAL_TRACKER_ID);
        if (!record) {
          record = {
            id: this.db.nextTrackId++, mangaId: manga.id, remoteId, remoteUrl: manga.realUrl || manga.url || '', title: manga.title || '',
            status: 1, lastChapterRead: 0, totalChapters: this.db.chapters.filter(chapter => String(chapter.mangaId) === String(manga.id)).length,
            score: 0, startDate: UNSET_TRACK_DATE, finishDate: UNSET_TRACK_DATE, private: input.private === true,
          };
          this.db.trackRecords.push(record);
        } else {
          Object.assign(record, { remoteId, remoteUrl: manga.realUrl || manga.url || '', title: manga.title || '', private: input.private === true });
        }
        this.syncLocalTrackProgress(manga.id);
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecord: this.trackRecord(record) };
      }
      case 'bindTrackRecord': {
        const sourceRecord = this.trackRecordFor(input.trackRecordId);
        const mangaId = Number(input.mangaId);
        if (!Number.isInteger(mangaId)) throw new TypeError('mangaId must be an integer');
        const manga = this.find('mangas', mangaId);
        let record = this.db.trackRecords.find(candidate => String(candidate.mangaId) === String(manga.id) && Number(candidate.trackerId ?? LOCAL_TRACKER_ID) === LOCAL_TRACKER_ID);
        if (!record) {
          record = { ...structuredClone(sourceRecord), id: this.db.nextTrackId++, mangaId: manga.id, remoteId: String(manga.id), remoteUrl: manga.realUrl || manga.url || '', title: manga.title || '' };
          this.db.trackRecords.push(record);
        }
        this.syncLocalTrackProgress(manga.id);
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecord: this.trackRecord(record) };
      }
      case 'unbindTrack': {
        const record = this.trackRecordFor(input.recordId);
        const trackRecord = this.trackRecord(record);
        this.db.trackRecords = this.db.trackRecords.filter(candidate => candidate !== record);
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecord };
      }
      case 'updateTrack': {
        const record = this.trackRecordFor(input.recordId);
        const supported = new Set(['clientMutationId', 'recordId', 'finishDate', 'lastChapterRead', 'private', 'scoreString', 'startDate', 'status']);
        for (const key of Object.keys(input)) if (!supported.has(key)) unsupported('track patch ' + key);
        if (input.status != null && (!Number.isInteger(Number(input.status)) || !LOCAL_TRACKER_STATUSES.some(status => status.value === Number(input.status)))) throw new TypeError('status is not supported by the local tracker');
        if (input.lastChapterRead != null && (!Number.isFinite(Number(input.lastChapterRead)) || Number(input.lastChapterRead) < 0)) throw new TypeError('lastChapterRead must be a non-negative number');
        if (input.private != null && typeof input.private !== 'boolean') throw new TypeError('private must be boolean');
        if (input.scoreString != null && !LOCAL_TRACKER_SCORES.includes(String(input.scoreString))) throw new TypeError('scoreString is not supported by the local tracker');
        if (input.status != null) record.status = Number(input.status);
        if (input.lastChapterRead != null) record.lastChapterRead = Number(input.lastChapterRead);
        if (input.private != null) record.private = input.private;
        if (input.scoreString != null) record.score = Number(input.scoreString);
        if (input.startDate !== undefined) record.startDate = this.normalizeTrackDate(input.startDate, 'startDate');
        if (input.finishDate !== undefined) record.finishDate = this.normalizeTrackDate(input.finishDate, 'finishDate');
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecord: this.trackRecord(record) };
      }
      case 'fetchTrack': {
        const record = this.trackRecordFor(input.recordId);
        const trackRecords = this.syncLocalTrackProgress(record.mangaId);
        const trackRecord = trackRecords.find(candidate => Number(candidate.id) === Number(record.id)) || this.trackRecord(record);
        await this.save();
        return { clientMutationId: input.clientMutationId ?? null, trackRecord };
      }
      case 'lastSyncStatus': return null; // No external sync service is connected.
      default: unsupported(name);
    }
  }
  fetch(url, options = {}) {
    const operation = () => this.coordinated(() => this.fetchOperation(url, options));
    const imagePath = new URL(url, 'https://local.invalid').pathname;
    const isRecoverableImage = /\/chapter\/\d+\/page\/\d+/.test(imagePath) || /\/manga\/\d+\/thumbnail/.test(imagePath);
    const result = isRecoverableImage && this.permissionRecovery
      ? this.permissionRecovery.run(`reader:${++this.nextPermissionImage}`, operation, { signal: options.signal }) : operation();
    result.catch(error => recordBrowserDiagnosticError(error, [String(url), ...libraryPrivateStrings(this.db)]));
    return result;
  }
  async getDiagnostics() {
    return this.coordinated(async () => {
      const runtime = globalThis.chrome || globalThis.browser;
      let manifest = {};
      try { manifest = runtime?.runtime?.getManifest?.() || {}; } catch { /* unavailable outside the extension page */ }
      const [extensions, pages, savedJvmState, estimate, persisted] = await Promise.all([
        this.store.getAllByPrefix('settings', 'extension:'),
        this.store.getPrefixStats('settings', 'webui:page:'),
        this.store.get('settings', 'jvm:preferences'),
        globalThis.navigator?.storage?.estimate?.().catch?.(() => ({})) ?? Promise.resolve({}),
        globalThis.navigator?.storage?.persisted?.().catch?.(() => null) ?? Promise.resolve(null),
      ]);
      let savedPreferences = {};
      try { savedPreferences = JSON.parse(savedJvmState?.value || '{}'); } catch { /* ignore malformed private state */ }
      const sensitiveValues = [
        ...libraryPrivateStrings(this.db),
        ...collectStrings(savedPreferences),
        ...collectStrings(savedJvmState?.files?.entries?.map(entry => ({ path: entry.path, type: entry.type }))),
      ];
      for (const entry of savedJvmState?.files?.entries || []) {
        if (!/cookie|token|auth|session/i.test(String(entry.path || '')) || !entry.bytes) continue;
        try { sensitiveValues.push(new TextDecoder().decode(entry.bytes)); } catch { /* optional redaction hint */ }
      }
      let libraryDatabaseBytes = 0;
      try { libraryDatabaseBytes = new TextEncoder().encode(JSON.stringify(this.db)).byteLength; } catch { /* report zero if malformed */ }
      const queue = this.db.downloads?.queue || [];
      return createBrowserDiagnostics({
        extensionVersion: manifest.version,
        extensionId: runtime?.runtime?.id,
        navigator: globalThis.navigator,
        installedExtensions: extensions.map(record => ({
          packageName: record.packageName,
          version: record.version,
          versionCode: record.versionCode,
          verification: record.verification || (record.signerFingerprint ? 'verified' : 'pre-0.3.0'),
        })),
        repositories: (this.db.repositories || []).map(record => ({ name: record.name, signingKey: record.signingKey })),
        storage: {
          usage: estimate?.usage,
          quota: estimate?.quota,
          persisted,
          cachedPageCount: pages.count,
          cachedPageBlobBytes: pages.blobBytes,
          libraryDatabaseBytes,
        },
        counts: { mangas: this.db.mangas.length, chapters: this.db.chapters.length },
        queueStates: queue.map(row => row.state),
        sensitiveValues,
      });
    });
  }
  async fetchOperation(url, options = {}) {
    await this.loading;
    const path = new URL(url, 'https://local.invalid').pathname;
    const backup = /^\/browser-local\/backup\/([^/]+)$/.exec(path);
    if (backup) {
      const stored = await this.store.get('settings', `webui:backup:${backup[1]}`);
      if (!(stored?.blob instanceof Blob) || !stored.blob.size) throw new Error('Browser backup no longer exists');
      return new Response(stored.blob, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment' } });
    }
    const page = /\/chapter\/(\d+)\/page\/(\d+)/.exec(path);
    if (page) {
      const chapter = this.find('chapters', page[1]), manga = this.find('mangas', chapter.mangaId);
      const index = Number(page[2]);
      if ((chapter.browserPagesNeedRefresh || !chapter.pages?.[index]) && await this.source(manga.sourceId)) {
        await this.refreshPageManifest(chapter);
        await this.preparePagePermissions(chapter.pages);
        await this.save();
      }
      let pageInfo = chapter.pages?.[index];
      if (!pageInfo) throw new RangeError('Chapter page does not exist');
      let remoteUrl = JSON.stringify([pageInfo.url, pageInfo.imageUrl]);
      const key = `webui:page:${chapter.id}:${page[2]}`;
      let stored = await this.store.get('settings', key);
      if (!(stored?.blob instanceof Blob) || !stored.blob.size || stored.remoteUrl !== remoteUrl) {
        if (chapter.isDownloaded) { chapter.isDownloaded = false; await this.save(); }
        if (!await this.source(manga.sourceId)) throw new Error(`Page ${Number(page[2]) + 1} is not cached and source ${manga.sourceId} is not installed`);
        let image;
        try { image = await this.manager.call(manga.sourceId, 'image', { pageInfo }); }
        catch (error) {
          // One inline repair of an expired address, not a download queue retry.
          // Permission failures wait for a grant; timeouts/5xx stay manual.
          if (!expiredImageAddress(error)) throw error;
          const previous = JSON.stringify(pageInfo);
          await this.refreshPageManifest(chapter);
          const refreshed = chapter.pages[index];
          await this.preparePagePermissions(chapter.pages); await this.save();
          if (!refreshed || JSON.stringify(refreshed) === previous) throw error;
          pageInfo = refreshed; remoteUrl = JSON.stringify([pageInfo.url, pageInfo.imageUrl]);
          image = await this.manager.call(manga.sourceId, 'image', { pageInfo });
        }
        const bytes = decodeBytes(image.body);
        if (!bytes.length) throw new Error('Source returned an empty page image');
        stored = { key, remoteUrl, blob: new Blob([bytes], { type: image.mimeType }) };
        await this.store.put('settings', stored);
        const cached = await this.cachedChapterPages(chapter);
        chapter.isDownloaded = cached.length > 0 && cached.every(Boolean);
        await this.save();
      }
      return new Response(stored.blob, { headers: { 'Content-Type': stored.blob.type } });
    }
    const mangaImage = /\/manga\/(\d+)\/thumbnail/.exec(path);
    if (mangaImage) {
      const manga = this.find('mangas', mangaImage[1]);
      const key = `webui:thumbnail:${manga.id}`;
      let cached = await this.store.get('settings', key);
      if (!(cached?.blob instanceof Blob) || !cached.blob.size || cached.remoteUrl !== manga.thumbnailUrl) {
        if (!await this.source(manga.sourceId)) throw new Error(`Cover is not cached and source ${manga.sourceId} is not installed`);
        const image = await this.manager.call(manga.sourceId, 'thumbnail', { url: manga.thumbnailUrl });
        cached = { key, remoteUrl: manga.thumbnailUrl, blob: new Blob([decodeBytes(image.body)], { type: image.mimeType }) };
        await this.store.put('settings', cached);
      }
      return new Response(cached.blob, { headers: { 'Content-Type': cached.blob.type } });
    }
    const requestUrl = url;
    if (!/^https?:/.test(requestUrl) || path.startsWith('/browser-local/')) unsupported('local image endpoint ' + path);
    const response = await this.transport({ url: requestUrl, method: 'GET' });
    return new Response(decodeBytes(response.body), { status: response.status, headers: response.headers });
  }
}

let backend;
export function getBrowserBackend({ databaseName, transport } = {}) {
  return backend ||= new BrowserBackend(new IndexedDbStore(globalThis.indexedDB, databaseName), { transport, workerUrl: new URL('src/extensions/worker.mjs', new URL('../', document.baseURI)) });
}
