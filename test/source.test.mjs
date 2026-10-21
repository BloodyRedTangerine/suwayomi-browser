import assert from "node:assert/strict";
import test from "node:test";

import { LocalCatalog, MemoryStore } from "../src/core.mjs";
import { LocalCatalogSource, SourceRegistry, validateSource } from "../src/source.mjs";

test("source registry validates and exposes browser adapters", async () => {
  const catalog = new LocalCatalog(new MemoryStore());
  const manga = await catalog.addManga({ title: "A local title" });
  const chapter = await catalog.addChapter({
    mangaId: manga.id,
    pages: [{ name: "page.png", blob: new Blob(["page"], { type: "image/png" }) }],
  });
  const source = new LocalCatalogSource(catalog);
  const registry = new SourceRegistry([source]);

  assert.equal(validateSource(source), source);
  assert.equal(registry.get("local"), source);
  assert.equal((await source.search("LOCAL")).length, 1);
  assert.equal((await source.getChapters(manga.id))[0].id, chapter.id);
  assert.equal((await source.getPages(chapter.id))[0].name, "page.png");
});

test("source registry rejects incomplete adapters", () => {
  assert.throws(() => validateSource({ id: "broken" }), /missing search/);
});
