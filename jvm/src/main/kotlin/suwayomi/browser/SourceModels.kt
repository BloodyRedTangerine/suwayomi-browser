package suwayomi.browser

import eu.kanade.tachiyomi.source.model.*
import kotlinx.serialization.json.*

/** Restore source-visible fields, not just the URL, on cold backend calls. */
object SourceModels {
    /** Server-style detail merge: nullable fields preserve saved values; memo/policy replace. */
    fun mergeDetails(previous: SManga, returned: SManga): SManga = SManga.create().apply {
        url = previous.url
        title = (try { returned.title } catch (_: UninitializedPropertyAccessException) { "" }).ifEmpty { previous.title }
        author = returned.author ?: previous.author
        artist = returned.artist ?: previous.artist
        description = returned.description ?: previous.description
        genre = returned.genre ?: previous.genre
        thumbnail_url = returned.thumbnail_url?.takeIf { it.isNotEmpty() } ?: previous.thumbnail_url
        status = returned.status
        memo = returned.memo
        update_strategy = returned.update_strategy
        initialized = true
    }
    fun manga(data: JsonObject): SManga = SManga.create().apply {
        url = data.getValue("url").jsonPrimitive.content
        title = data["title"]?.jsonPrimitive?.contentOrNull ?: url
        author = data["author"]?.jsonPrimitive?.contentOrNull
        artist = data["artist"]?.jsonPrimitive?.contentOrNull
        description = data["description"]?.jsonPrimitive?.contentOrNull
        thumbnail_url = data["thumbnailUrl"]?.jsonPrimitive?.contentOrNull
        genre = when (val genres = data["genre"]) {
            is JsonArray -> genres.joinToString(", ") { it.jsonPrimitive.content }
            else -> genres?.jsonPrimitive?.contentOrNull
        }
        status = data["status"]?.jsonPrimitive?.let { value ->
            value.intOrNull ?: listOf("UNKNOWN", "ONGOING", "COMPLETED", "LICENSED", "PUBLISHING_FINISHED", "CANCELLED", "ON_HIATUS").indexOf(value.content).coerceAtLeast(0)
        } ?: SManga.UNKNOWN
        initialized = data["initialized"]?.jsonPrimitive?.booleanOrNull ?: false
        data["updateStrategy"]?.jsonPrimitive?.contentOrNull?.let { update_strategy = UpdateStrategy.valueOf(it) }
        data["memo"]?.takeUnless { it is JsonNull }?.jsonObject?.let { memo = it }
    }
    fun chapter(data: JsonObject): SChapter = SChapter.create().apply {
        url = data.getValue("url").jsonPrimitive.content
        name = data["name"]?.jsonPrimitive?.contentOrNull ?: url
        chapter_number = (data["number"] ?: data["chapterNumber"])?.jsonPrimitive?.floatOrNull ?: -1f
        date_upload = (data["dateUpload"] ?: data["uploadDate"])?.jsonPrimitive?.longOrNull ?: 0L
        scanlator = data["scanlator"]?.jsonPrimitive?.contentOrNull
        data["memo"]?.takeUnless { it is JsonNull }?.jsonObject?.let { memo = it }
    }
}
