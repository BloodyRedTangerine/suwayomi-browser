const inclusion = value => typeof value === 'boolean' ? (value ? 'INCLUDE' : 'EXCLUDE') : (value ?? 'UNSET');
export function categoryFields(record) {
  return { ...record, default: record.isDefaultCategory || record.id === 0 ? false : !!record.default,
    includeInUpdate: inclusion(record.includeInUpdate), includeInDownload: inclusion(record.includeInDownload) };
}
const int = (value, label) => {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new TypeError(label + ' must be a GraphQL Int');
  return value;
};
const name = value => {
  if (typeof value !== 'string' || [...value].length > 64) throw new TypeError('Category name must be a string of at most 64 characters');
};
function patchFields(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Category patch required');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!['name', 'default', 'includeInUpdate', 'includeInDownload'].includes(key)) throw new TypeError('Unknown category patch field: ' + key);
    if (value == null) continue; // Nullable upstream patch fields mean no change.
    if (key === 'name') name(value);
    else if (key === 'default') { if (typeof value !== 'boolean') throw new TypeError('Category default must be boolean'); }
    else if (!['UNSET', 'INCLUDE', 'EXCLUDE'].includes(value)) throw new TypeError('Invalid category inclusion value');
    result[key] = value;
  }
  return result;
}
const builtin = category => category.isDefaultCategory || category.id === 0;
function ordered(db) {
  return [...db.categories].sort((a, b) => Number(builtin(b)) - Number(builtin(a)) || (a.order || 0) - (b.order || 0) || a.id - b.id);
}
function normalize(db, categories = ordered(db)) {
  categories.forEach((category, index) => { category.order = index; });
  db.categories = categories;
}

/** In-memory mutations; validate the entire request before changing records.
 * The backend supplies cross-tab coordination and commits to IndexedDB.
 */
export function mutateCategories(db, operation, input) {
  const clientMutationId = input.clientMutationId ?? null;
  const find = id => {
    int(id, 'Category ID');
    const record = db.categories.find(category => category.id === id);
    if (!record) throw new Error('Category ' + id + ' does not exist');
    return record;
  };
  switch (operation) {
    case 'createCategory': {
      name(input.name);
      if (input.name.toLowerCase() === 'default') throw new Error('Category name must not be Default');
      if (db.categories.some(category => category.name === input.name)) throw new Error('Category name must be unique');
      if (input.order != null && int(input.order, 'Category order') <= 0) throw new RangeError('Category order must be > 0');
      const patch = patchFields(Object.fromEntries(['default', 'includeInUpdate', 'includeInDownload'].map(key => [key, input[key]])));
      const id = db.categories.reduce((next, category) => Math.max(next, category.id + 1), Math.max(db.nextId, 1));
      int(id, 'New category ID');
      const category = { id, name: input.name, order: input.order ?? 2147483647, default: false, isDefaultCategory: false, includeInUpdate: 'UNSET', includeInDownload: 'UNSET', meta: [], ...patch };
      if (input.order != null) for (const old of db.categories) if (old.order >= input.order) old.order++;
      db.categories.push(category); db.nextId = id + 1; normalize(db);
      return { category, clientMutationId };
    }
    case 'updateCategory': case 'updateCategories': {
      const single = operation === 'updateCategory';
      const ids = single ? [input.id] : input.ids;
      if (!Array.isArray(ids)) throw new TypeError('Category IDs must be an array');
      const records = [...new Set(ids)].map(find);
      const patch = patchFields(input.patch);
      for (const category of records) {
        const changes = { ...patch };
        if (builtin(category)) { delete changes.name; delete changes.default; }
        Object.assign(category, changes);
      }
      return { ...(single ? { category: records[0] } : { categories: records }), clientMutationId };
    }
    case 'updateCategoryOrder': {
      int(input.id, 'Category ID');
      if (int(input.position, 'Category position') <= 0) throw new RangeError('Category position must be > 0');
      const categories = ordered(db), from = categories.findIndex(category => category.id === input.id && !builtin(category));
      // Upstream ignores an unknown/default ID; positions beyond the end clamp.
      if (from >= 0) {
        const [moved] = categories.splice(from, 1);
        const defaultCount = categories.filter(builtin).length;
        categories.splice(Math.min(defaultCount + input.position - 1, categories.length), 0, moved);
        normalize(db, categories);
      }
      return { categories: ordered(db), clientMutationId };
    }
    case 'deleteCategory': {
      int(input.categoryId, 'Category ID');
      const category = db.categories.find(record => record.id === input.categoryId);
      if (!category || builtin(category)) return { category: null, mangas: [], clientMutationId };
      const mangas = db.mangas.filter(manga => manga.categoryIds?.includes(category.id));
      for (const manga of mangas) {
        manga.categoryIds = manga.categoryIds.filter(id => id !== category.id && id !== 0);
        if (!manga.categoryIds.length) manga.categoryIds = [0];
      }
      db.categories = db.categories.filter(record => record !== category); normalize(db);
      return { category, mangas, clientMutationId };
    }
    default: return null;
  }
}
