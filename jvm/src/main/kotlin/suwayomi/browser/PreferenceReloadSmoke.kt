package suwayomi.browser

import androidx.preference.ListPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.source.*
import eu.kanade.tachiyomi.source.model.*
import kotlinx.serialization.json.*

/** Synthetic API fixture: a value deliberately cached in the source constructor. */
class PreferenceReloadFactory : SourceFactory {
    override fun createSources(): List<Source> = listOf(PreferenceReloadSource())
}

private class PreferenceReloadSource : ConfigurableSource {
    override val id = 991064001L
    override val name = "Constructor preference fixture"
    override val lang = "en"
    override val supportsLatest = false
    private val captured = sourcePreferences().getString("choice", "a")!!
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        screen.addPreference(ListPreference(screen.context).apply {
            key = "choice"; title = "Choice"; entries = arrayOf("A", "B"); entryValues = arrayOf("a", "b"); setDefaultValue("a")
        })
    }
    override suspend fun getPopularManga(page: Int) = MangasPage(listOf(SManga.create().apply { url = "/probe"; title = captured }), false)
    override suspend fun getLatestUpdates(page: Int): MangasPage = error("Unused synthetic API")
    override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage = error("Unused synthetic API")
    override suspend fun getMangaUpdate(manga: SManga, chapters: List<SChapter>, fetchDetails: Boolean, fetchChapters: Boolean): SMangaUpdate = error("Unused synthetic API")
    override suspend fun getPageList(chapter: SChapter): List<Page> = error("Unused synthetic API")
}

object PreferenceReloadSmoke {
    @JvmStatic fun verify(jar: String) {
        Gateway.install(jar, "suwayomi.browser.PreferenceReloadFactory")
        fun title() = Json.parseToJsonElement(Gateway.call("""{"sourceId":"991064001","operation":"popular"}""")).jsonObject["mangas"]!!.jsonArray[0].jsonObject["title"]!!.jsonPrimitive.content
        val before = title()
        val next = if (before == "a") "b" else "a"
        Gateway.call("""{"sourceId":"991064001","operation":"preference","change":{"position":0,"listState":"$next"}}""")
        check(title() == next) { "Changing preferences did not recreate constructor-cached source state" }
        println("Source factory recreation after preference changes verified")
    }
}
