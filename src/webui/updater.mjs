const int = (value, label) => {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new TypeError(`${label} must be a non-negative GraphQL Int`);
  return value;
};

/**
 * Durable browser-local updater state.  The queue is deliberately stored in
 * the same database record as the catalog so a reload can resume a manga at
 * a request boundary.  A RUNNING row is therefore runnable after a crash or
 * a tab being suspended.
 */
export const updaterState = db => db.updater ||= {
  state: 'STOPPED',
  queue: [],
  categoryUpdates: [],
  skippedCategoryIds: [],
  skippedMangaIds: [],
  skippedCategoriesCount: 0,
  lastUpdateTimestamp: 0,
};

export function categoryIds(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) throw new TypeError('Update category IDs must be an array');
  return [...new Set(input.map(value => int(value, 'Update category ID')))];
}

export function activeUpdaterJob(row) {
  return row?.state === 'PENDING' || row?.state === 'RUNNING';
}

export function updaterIsRunning(state) {
  return state.queue.some(activeUpdaterJob);
}

export function clearUpdater(state) {
  state.state = 'STOPPED';
  state.queue = [];
  state.categoryUpdates = [];
  state.skippedCategoryIds = [];
  state.skippedMangaIds = [];
  state.skippedCategoriesCount = 0;
}

export function normalizeUpdaterState(state) {
  if (!['STARTED', 'STOPPED'].includes(state.state)) state.state = 'STOPPED';
  if (!Array.isArray(state.queue)) state.queue = [];
  if (!Array.isArray(state.categoryUpdates)) state.categoryUpdates = [];
  if (!Array.isArray(state.skippedCategoryIds)) state.skippedCategoryIds = [];
  if (!Array.isArray(state.skippedMangaIds)) state.skippedMangaIds = [];
  if (!Number.isInteger(state.skippedCategoriesCount) || state.skippedCategoriesCount < 0) state.skippedCategoriesCount = 0;
  if (!Number.isSafeInteger(state.lastUpdateTimestamp) || state.lastUpdateTimestamp < 0) state.lastUpdateTimestamp = 0;
  if (!Number.isSafeInteger(state.lastAutomatedUpdateTimestamp) || state.lastAutomatedUpdateTimestamp < 0) state.lastAutomatedUpdateTimestamp = 0;
  for (const row of state.queue) {
    if (!['PENDING', 'RUNNING', 'COMPLETE', 'FAILED'].includes(row.state)) row.state = 'FAILED';
    if (!Number.isInteger(row.tries) || row.tries < 0) row.tries = 0;
  }
  return state;
}
