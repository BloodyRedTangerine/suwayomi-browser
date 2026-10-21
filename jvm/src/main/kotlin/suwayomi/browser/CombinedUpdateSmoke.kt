package suwayomi.browser

import eu.kanade.tachiyomi.source.model.*
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.serialization.json.*

class CombinedUpdateSource : HttpSource() {
    override val id = 991064002L
    override val name = "Combined update fixture"
    override val lang = "en"
    override val supportsLatest = false
    override val baseUrl = "https://combined.example.test"
    private var calls = 0
    private var details = false
    override suspend fun getMangaUpdate(manga: SManga, chapters: List<SChapter>, fetchDetails: Boolean, fetchChapters: Boolean): SMangaUpdate {
        calls++; details = fetchDetails
        check(manga.author == "Author" && chapters.single().memo["token"]!!.jsonPrimitive.content == "known")
        manga.author = "Mutated input must not replace saved fallback"
        val updated = SManga.create().apply {
            title = "Volume 99"; artist = "New Artist"; status = 2
            update_strategy = UpdateStrategy.ONLY_FETCH_ONCE
            memo = buildJsonObject { put("calls", calls); put("details", fetchDetails); put("chapters", fetchChapters) }
        }
        val chapter = SChapter.create().apply {
            url = "/seven"; name = (if (fetchDetails) "Volume 99" else "Old title") + " - Chapter 7"
            memo = buildJsonObject { put("calls", calls); put("details", fetchDetails); put("chapters", fetchChapters) }
        }
        return SMangaUpdate(updated, listOf(chapter))
    }
    @Suppress("DEPRECATION")
    override fun prepareNewChapter(chapter: SChapter, manga: SManga) {
        check(manga.title == if (details) "Volume 99" else "Old title")
        check(manga.author == "Author" && manga.genre == "A, B" && manga.description == "Saved")
    }
}

object CombinedUpdateSmoke {
    @JvmStatic fun verify(jar: String) {
        val previous = SManga.create().apply { url = "/saved"; title = "Saved title"; author = "Author" }
        val partial = SourceModels.mergeDetails(previous, SManga.create())
        check(partial.url == "/saved" && partial.title == "Saved title" && partial.author == "Author")
        Gateway.install(jar, "suwayomi.browser.CombinedUpdateSource")
        fun call(operation: String, details: Boolean, chapters: Boolean): JsonObject = Json.parseToJsonElement(Gateway.call("""{"sourceId":"991064002","operation":"$operation","fetchDetails":$details,"fetchChapters":$chapters,"manga":{"url":"/saved","title":"Old title","author":"Author","description":"Saved","genre":["A","B"],"thumbnailUrl":"cover"},"knownChapters":[{"url":"/known","name":"Known","number":1,"memo":{"token":"known"}}]}""")).jsonObject
        val combined = call("update", true, true)
        val manga = combined["manga"]!!.jsonObject
        check(manga["url"]!!.jsonPrimitive.content == "/saved" && manga["title"]!!.jsonPrimitive.content == "Volume 99")
        check(manga["author"]!!.jsonPrimitive.content == "Author" && manga["description"]!!.jsonPrimitive.content == "Saved" && manga["thumbnailUrl"]!!.jsonPrimitive.content == "cover")
        check(manga["artist"]!!.jsonPrimitive.content == "New Artist" && manga["updateStrategy"]!!.jsonPrimitive.content == "ONLY_FETCH_ONCE")
        check(manga["memo"]!!.jsonObject["calls"]!!.jsonPrimitive.int == 1)
        val chapter = combined["chapters"]!!.jsonArray.single().jsonObject
        check(chapter["number"]!!.jsonPrimitive.float == 7f && chapter["name"]!!.jsonPrimitive.content == "Chapter 7")
        val onlyChapters = call("update", false, true)
        check(onlyChapters["manga"]!!.jsonObject["title"]!!.jsonPrimitive.content == "Old title")
        check(onlyChapters["chapters"]!!.jsonArray.single().jsonObject["memo"]!!.jsonObject["calls"]!!.jsonPrimitive.int == 2)
        check(call("details", true, false)["updateStrategy"]!!.jsonPrimitive.content == "ONLY_FETCH_ONCE")
        println("Combined update: single source invocation, flags, known metadata, nullable merge, immutable fallback, policy and updated-title chapter preparation verified")
    }
}
