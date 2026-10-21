package suwayomi.browser

import android.app.Application
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.source.model.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.*
import kotlinx.serialization.protobuf.ProtoBuf
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.addSingleton
import uy.kohesive.injekt.api.get
import java.net.URLClassLoader
import java.nio.file.Path
import java.util.Base64

/** JSON facade over the same extension API used by Suwayomi's server. */
@OptIn(ExperimentalSerializationApi::class)
object Gateway {
    private val sources = mutableMapOf<String, Source>()
    private val loaders = mutableListOf<URLClassLoader>()
    private val reloaders = mutableMapOf<String, () -> List<Source>>()
    init {
        android.os.Looper.prepareMainLooper()
        val application = Application()
        Injekt.addSingleton(application)
        val network = NetworkHelper(application)
        Injekt.addSingleton(network)
        android.webkit.CookieManager.bindCookieStore(network.cookieStore)
        Injekt.addSingleton(eu.kanade.tachiyomi.network.JavaScriptEngine(application))
        // Match the server's shared Json configuration. Several sources rely
        // on absent nullable fields being treated as null when decoding site
        // responses (notably page/auth DTOs).
        Injekt.addSingleton(Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        })
        Injekt.addSingleton<ProtoBuf>(ProtoBuf)
    }
    private fun createSources(loader: URLClassLoader, className: String): List<Source> {
        val entry = Class.forName(className, true, loader).getDeclaredConstructor().newInstance()
        return when (entry) {
            is SourceFactory -> entry.createSources()
            is Source -> listOf(entry)
            else -> error("Extension entry is neither Source nor SourceFactory: $className")
        }
    }
    @JvmStatic fun dateHelperProbe(value: String): String {
        val loader = sources.values.first().javaClass.classLoader
        val helper = Class.forName("keiyoushi.b.a", true, loader)
        val method = helper.getMethod("a", java.time.format.DateTimeFormatter::class.java, String::class.java, java.time.ZoneId::class.java)
        val formatter = java.time.format.DateTimeFormatter.ofPattern("dd MMMM, yyyy", java.util.Locale.forLanguageTag("es")).withZone(java.time.ZoneId.of("UTC"))
        return "epoch=${method.invoke(null, formatter, value, null)};continued=true"
    }
    @JvmStatic fun install(jarPath: String, className: String): String {
        val loader = URLClassLoader(arrayOf(Path.of(jarPath).toUri().toURL()), Gateway::class.java.classLoader)
        val installed = createSources(loader, className)
        val factory = { createSources(loader, className) }
        installed.forEach { sources[it.id.toString()] = it; reloaders[it.id.toString()] = factory }
        loaders.add(loader)
        return buildJsonArray { installed.forEach { source -> add(buildJsonObject {
            put("id", source.id.toString()); put("name", source.name); put("lang", source.lang)
            put("supportsLatest", source.supportsLatest)
            put("isConfigurable", source is ConfigurableSource)
            if (source is HttpSource) put("baseUrl", source.baseUrl)
        }) } }.toString()
    }

    private fun manga(value: SManga, source: Source): JsonObject = buildJsonObject {
        put("url", value.url); put("title", value.title); put("author", value.author); put("artist", value.artist)
        put("description", value.description); put("thumbnailUrl", value.thumbnail_url); put("genre", value.genre); put("status", value.status)
        put("memo", value.memo)
        put("updateStrategy", value.update_strategy.name)
        if (source is HttpSource) put("realUrl", source.getMangaUrl(value))
    }
    private fun chapter(value: SChapter, source: Source): JsonObject = buildJsonObject {
        put("url", value.url); put("name", value.name); put("number", value.chapter_number); put("dateUpload", value.date_upload); put("scanlator", value.scanlator)
        put("memo", value.memo)
        if (source is HttpSource) put("realUrl", source.getChapterUrl(value))
    }

    @JvmStatic fun call(input: String): String = runBlocking(Dispatchers.IO) {
        val args = Json.parseToJsonElement(input).jsonObject
        val source = sources[args["sourceId"]!!.jsonPrimitive.content] ?: error("Source not installed")
        val page = args["page"]?.jsonPrimitive?.int ?: 1
        val result: JsonElement = when (args["operation"]!!.jsonPrimitive.content) {
            "filters" -> SourceFilters.describe(source.getFilterList())
            "capabilities" -> buildJsonObject { put("isConfigurable", source is ConfigurableSource) }
            "preferences" -> if (source is ConfigurableSource) SourcePreferences.describe(SourcePreferences.screen(source)) else JsonArray(emptyList())
            "preference" -> {
                require(source is ConfigurableSource) { "Source does not provide preferences" }
                SourcePreferences.update(SourcePreferences.screen(source), args["change"]?.jsonObject ?: error("Missing preference change"))
                // Recreate factory sources so constructor/lazy preference reads
                // do not retain old values. Classloader code stays local.
                val factory = reloaders[source.id.toString()] ?: error("Source factory is not registered")
                val fresh = factory()
                require(fresh.any { it.id == source.id }) { "Preference changed source identity; reinstall the extension to refresh its source list" }
                reloaders.filterValues { it === factory }.keys.toList().forEach { sources.remove(it); reloaders.remove(it) }
                fresh.forEach { sources[it.id.toString()] = it; reloaders[it.id.toString()] = factory }
                val updated = sources[source.id.toString()] as? ConfigurableSource ?: error("Source configuration changed its identity")
                SourcePreferences.describe(SourcePreferences.screen(updated))
            }
            "popular", "latest", "search" -> {
                val result = when (args["operation"]!!.jsonPrimitive.content) {
                    "popular" -> source.getPopularManga(page)
                    "latest" -> source.getLatestUpdates(page)
                    else -> {
                        val filters = source.getFilterList()
                        val restore = SourceFilters.apply(filters, args["filters"])
                        try { source.getSearchManga(page, args["query"]?.jsonPrimitive?.content ?: "", filters) }
                        finally { restore.close() }
                    }
                }
                buildJsonObject { put("mangas", buildJsonArray { result.mangas.forEach { add(manga(it, source)) } }); put("hasNextPage", result.hasNextPage) }
            }
            "details", "chapters", "update" -> {
                val data = args["manga"]?.jsonObject ?: args
                val manga = SourceModels.manga(data)
                val previous = SourceModels.manga(data)
                val knownChapters = args["knownChapters"]?.jsonArray?.map { SourceModels.chapter(it.jsonObject) } ?: emptyList()
                val operation = args["operation"]!!.jsonPrimitive.content
                val details = if (operation == "update") args["fetchDetails"]?.jsonPrimitive?.boolean ?: false else operation == "details"
                val chapters = if (operation == "update") args["fetchChapters"]?.jsonPrimitive?.boolean ?: false else operation == "chapters"
                val update = source.getMangaUpdate(manga, knownChapters, details, chapters)
                val effective = if (details) SourceModels.mergeDetails(previous, update.manga) else previous
                val chapterData = if (chapters) buildJsonArray { SourceChapterPipeline.prepare(source, effective, update.chapters).forEach { add(chapter(it, source)) } } else buildJsonArray { }
                when (operation) {
                    "details" -> manga(effective, source)
                    "chapters" -> chapterData
                    else -> buildJsonObject { put("manga", manga(effective, source)); put("chapters", chapterData) }
                }
            }
            "pages" -> {
                val data = args["chapter"]?.jsonObject ?: args
                val chapter = SourceModels.chapter(data)
                val pages = source.getPageList(chapter)
                buildJsonArray { pages.forEach { page ->
                    if (page.imageUrl == null && source is HttpSource) page.imageUrl = source.getImageUrl(page)
                    add(buildJsonObject { put("index", page.index); put("url", page.url); put("imageUrl", page.imageUrl) })
                } }
            }
            "thumbnail" -> {
                check(source is HttpSource) { "Thumbnail requests require an HTTP source" }
                // Covers are ordinary source-client requests. A chapter's
                // imageRequest override may require per-page token metadata.
                source.client.newCall(GET(args["url"]!!.jsonPrimitive.content, source.headers)).awaitSuccess().use { response -> buildJsonObject {
                    put("mimeType", response.body.contentType()?.toString() ?: "application/octet-stream")
                    put("body", Base64.getEncoder().encodeToString(response.body.bytes()))
                } }
            }
            "image" -> {
                check(source is HttpSource) { "Image request API requires an HTTP source" }
                val data = args["pageInfo"]!!.jsonObject
                val page = Page(data["index"]?.jsonPrimitive?.int ?: 0, data["url"]?.jsonPrimitive?.content ?: "", data["imageUrl"]!!.jsonPrimitive.content)
                source.getImage(page).use { response -> buildJsonObject {
                    put("mimeType", response.body.contentType()?.toString() ?: "application/octet-stream")
                    put("body", Base64.getEncoder().encodeToString(response.body.bytes()))
                } }
            }
            else -> error("Unknown extension operation")
        }
        result.toString()
    }
}
