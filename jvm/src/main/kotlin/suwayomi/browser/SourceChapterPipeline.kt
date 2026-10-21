package suwayomi.browser

import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.model.*
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.chapter.ChapterRecognition
import eu.kanade.tachiyomi.util.chapter.ChapterSanitizer.sanitize

/** Same source hook and number recognizer used by the server's chapter import. */
object SourceChapterPipeline {
    @Suppress("DEPRECATION")
    fun prepare(source: Source, manga: SManga, chapters: List<SChapter>): List<SChapter> = chapters.distinctBy { it.url }.onEach {
        (source as? HttpSource)?.prepareNewChapter(it, manga)
        it.chapter_number = ChapterRecognition.parseChapterNumber(manga.title, it.name, it.chapter_number.toDouble()).toFloat()
        it.name = it.name.sanitize(manga.title)
        it.scanlator = it.scanlator?.ifBlank { null }?.trim()
    }
}
