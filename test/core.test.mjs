import assert from "node:assert/strict";
import test from "node:test";

import { LocalCatalog, MemoryStore } from "../src/core.mjs";

function page(name, contents = name) {
  return { name, blob: new Blob([contents], { type: "image/png" }) };
}

test("stores a manga and its chapters in the local catalog", async () => {
  const catalog = new LocalCatalog(new MemoryStore());
  const manga = await catalog.addManga({ title: "  Local title  ", author: "Reader" });

  const chapter = await catalog.addChapter({
    mangaId: manga.id,
    title: "Chapter 1",
    pages: [page("001.png"), page("002.png")],
  });

  const detail = await catalog.getManga(manga.id);
  assert.equal(detail.title, "Local title");
  assert.equal(detail.chapters.length, 1);
  assert.equal(detail.chapters[0].id, chapter.id);
  assert.equal(detail.chapters[0].pageCount, 2);

  const storedChapter = await catalog.getChapter(chapter.id);
  assert.deepEqual(storedChapter.pages.map((item) => item.name), ["001.png", "002.png"]);
  assert.equal(await storedChapter.pages[0].blob.text(), "001.png");
});

test("persists and bounds reading progress", async () => {
  const catalog = new LocalCatalog(new MemoryStore());
  const manga = await catalog.addManga({ title: "Progress" });
  const chapter = await catalog.addChapter({ mangaId: manga.id, pages: [page("1"), page("2"), page("3")] });

  const progress = await catalog.setProgress(chapter.id, 999);
  assert.equal(progress.pageIndex, 2);
  assert.equal((await catalog.getProgress(chapter.id)).pageIndex, 2);

  const complete = await catalog.completeChapter(chapter.id);
  assert.equal(complete.completed, true);
});

test("library state and manga deletion clean up local records", async () => {
  const store = new MemoryStore();
  const catalog = new LocalCatalog(store);
  const manga = await catalog.addManga({ title: "Remove me" });
  const chapter = await catalog.addChapter({ mangaId: manga.id, pages: [page("1")] });
  await catalog.setLibraryState(manga.id, false);

  assert.equal((await catalog.listLibrary()).length, 0);
  await catalog.deleteManga(manga.id);
  assert.equal(await store.get("manga", manga.id), undefined);
  assert.equal(await store.get("chapters", chapter.id), undefined);
  assert.equal((await store.getAll("pages")).length, 0);
});
