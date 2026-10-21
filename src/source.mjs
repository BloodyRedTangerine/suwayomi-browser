/**
 * Small source-adapter contract for the browser runtime.
 *
 * Mihon extensions are JVM/DEX artifacts and cannot be executed directly by a
 * browser. A future port can implement this interface in JavaScript or WASM
 * without making the UI or persistence layer aware of the transport/runtime.
 */

export const SOURCE_METHODS = Object.freeze([
  "search",
  "getManga",
  "getChapters",
  "getPages",
]);

export function validateSource(source) {
  if (!source || typeof source.id !== "string" || !source.id.trim()) {
    throw new Error("A source adapter needs a non-empty id");
  }
  for (const method of SOURCE_METHODS) {
    if (typeof source[method] !== "function") {
      throw new Error(`Source ${source.id} is missing ${method}()`);
    }
  }
  return source;
}

export class SourceRegistry {
  constructor(sources = []) {
    this.sources = new Map();
    sources.forEach((source) => this.register(source));
  }

  register(source) {
    const validated = validateSource(source);
    if (this.sources.has(validated.id)) {
      throw new Error(`Source already registered: ${validated.id}`);
    }
    this.sources.set(validated.id, validated);
    return validated;
  }

  unregister(sourceId) {
    return this.sources.delete(sourceId);
  }

  get(sourceId) {
    return this.sources.get(sourceId);
  }

  list() {
    return [...this.sources.values()];
  }
}

/**
 * Adapter for the data already stored by LocalCatalog. It makes local data
 * consumable through the same shape as a network/WASM source adapter.
 */
export class LocalCatalogSource {
  constructor(catalog) {
    this.id = "local";
    this.name = "Local library";
    this.catalog = catalog;
  }

  async search(query = "") {
    const needle = String(query).trim().toLocaleLowerCase();
    const library = await this.catalog.listLibrary();
    return library.filter((manga) => !needle || manga.title.toLocaleLowerCase().includes(needle));
  }

  async getManga(mangaId) {
    return this.catalog.getManga(mangaId);
  }

  async getChapters(mangaId) {
    return this.catalog.listChapters(mangaId);
  }

  async getPages(chapterId) {
    const chapter = await this.catalog.getChapter(chapterId);
    return chapter?.pages ?? [];
  }
}
