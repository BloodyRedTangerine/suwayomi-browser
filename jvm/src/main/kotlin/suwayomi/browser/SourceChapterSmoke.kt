package suwayomi.browser

import eu.kanade.tachiyomi.source.model.*
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.chapter.ChapterRecognition
import kotlinx.serialization.json.*

object SourceChapterSmoke {
    @JvmStatic fun verify() {
        val manga = SourceModels.manga(Json.parseToJsonElement("""{"url":"42","title":"Series 99","author":"Author","artist":"Artist","description":"Details","thumbnailUrl":"https://image.test/cover","genre":["A","B"],"status":"COMPLETED","initialized":true,"updateStrategy":"ONLY_FETCH_ONCE","memo":{"path":"/series/"}}""").jsonObject)
        check(manga.author == "Author" && manga.artist == "Artist" && manga.description == "Details")
        check(manga.genre == "A, B" && manga.status == 2 && manga.initialized && manga.update_strategy == UpdateStrategy.ONLY_FETCH_ONCE)
        val known = SourceModels.chapter(Json.parseToJsonElement("""{"url":"chapter","name":"Old","chapterNumber":4.5,"uploadDate":1234,"scanlator":"Team","memo":{"token":"saved"}}""").jsonObject)
        check(known.chapter_number == 4.5f && known.date_upload == 1234L && known.scanlator == "Team" && known.memo["token"]!!.jsonPrimitive.content == "saved")
        var hooks = 0
        val source = object : HttpSource() {
            override val name = "Chapter pipeline fixture"
            override val lang = "en"
            override val supportsLatest = false
            override val baseUrl = "https://chapter.example.test"
            @Suppress("DEPRECATION")
            override fun prepareNewChapter(chapter: SChapter, manga: SManga) {
                check(manga.author == "Author" && manga.memo["path"]!!.jsonPrimitive.content == "/series/")
                hooks++; chapter.name = "Series 99 - Vol. 3 Ch. 12extra"; chapter.scanlator = " Team "
            }
        }
        val raw = SChapter.create().apply { url = "/12"; name = "unprepared"; memo = buildJsonObject { put("token", "chapter") } }
        val duplicate = SChapter.create().apply { url = "/12"; name = "duplicate" }
        val prepared = SourceChapterPipeline.prepare(source, manga, listOf(raw, duplicate))
        check(prepared.size == 1 && hooks == 1 && kotlin.math.abs(prepared[0].chapter_number - 12.99f) < 0.0001f)
        check(prepared[0].name == "Vol. 3 Ch. 12extra" && prepared[0].scanlator == "Team" && prepared[0].memo == raw.memo)
        for ((name, expected) in listOf("Ch. 1" to 1.0, "Chapter 0" to 0.0, "Chapter 12,5" to 12.5, "Chapter 12a" to 12.1, "Series 99 12 special" to 12.97, "Special" to -1.0)) {
            check(kotlin.math.abs(ChapterRecognition.parseChapterNumber("Series 99", name, -1.0) - expected) < 0.0001)
        }
        check(ChapterRecognition.parseChapterNumber("Series", "Chapter 99", 4.5) == 4.5)
        check(ChapterRecognition.parseChapterNumber("Series", "Chapter 99", -2.0) == -2.0)
        println("Chapter pipeline: full source fields/memo, hook-before-recognition, URL deduplication, sanitizer, supplied/unknown/sentinel numbers verified")
    }
}
