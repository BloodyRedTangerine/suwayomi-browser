package eu.kanade.tachiyomi.network

import android.content.Context
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.CookieStore
import java.net.HttpCookie
import java.net.URI

/** Source-owned cookies only. Persistent entries use the existing local preference snapshot.
 * Session entries deliberately live only for the lifetime of this source VM. */
class PersistentCookieStore(context: Context) : CookieStore {
    private val prefs = context.getSharedPreferences("cookie_store", Context.MODE_PRIVATE)
    private val entries = linkedMapOf<String, Cookie>()
    private fun key(cookie: Cookie) = "${cookie.domain}\n${cookie.path}\n${cookie.name}"

    init {
        // One malformed entry must not discard unrelated cookies. Never restore session entries.
        val saved = runCatching { Json.parseToJsonElement(prefs.getString("browser.cookies.v1", "[]")!!).jsonArray }.getOrNull()
        saved?.forEach { element ->
            runCatching {
                val row = element.jsonObject
                val builder = Cookie.Builder().name(row.getValue("name").jsonPrimitive.content)
                    .value(row.getValue("value").jsonPrimitive.content)
                    .path(row.getValue("path").jsonPrimitive.content)
                    .expiresAt(row.getValue("expiresAt").jsonPrimitive.long)
                val domain = row.getValue("domain").jsonPrimitive.content
                if (row.getValue("hostOnly").jsonPrimitive.boolean) builder.hostOnlyDomain(domain) else builder.domain(domain)
                if (row.getValue("secure").jsonPrimitive.boolean) builder.secure()
                if (row.getValue("httpOnly").jsonPrimitive.boolean) builder.httpOnly()
                val cookie = builder.build()
                if (cookie.expiresAt > System.currentTimeMillis()) entries[key(cookie)] = cookie
            }
        }
    }

    private fun save() {
        val now = System.currentTimeMillis()
        entries.entries.removeAll { it.value.expiresAt <= now }
        val snapshot = buildJsonArray {
            entries.values.filter { it.persistent }.forEach { cookie -> add(buildJsonObject {
                put("name", cookie.name); put("value", cookie.value); put("domain", cookie.domain)
                put("path", cookie.path); put("expiresAt", cookie.expiresAt); put("hostOnly", cookie.hostOnly)
                put("secure", cookie.secure); put("httpOnly", cookie.httpOnly)
            }) }
        }
        prefs.edit().putString("browser.cookies.v1", snapshot.toString()).commit()
    }

    @Synchronized fun addAll(url: HttpUrl, cookies: List<Cookie>) {
        cookies.forEach { cookie ->
            val allowed = url.host == cookie.domain || (!cookie.hostOnly && url.host.endsWith(".${cookie.domain}"))
            require(allowed) { "Cookie domain does not match response host" }
        }
        cookies.forEach { cookie -> entries[key(cookie)] = cookie }
        save()
    }

    @Synchronized fun get(url: HttpUrl): List<Cookie> {
        if (entries.values.any { it.expiresAt <= System.currentTimeMillis() }) save()
        // RFC path precedence; stable insertion order breaks equal-path ties.
        return entries.values.filter { it.matches(url) }.sortedByDescending { it.path.length }
    }

    @Synchronized fun getStoredCookies(): List<Cookie> {
        if (entries.values.any { it.expiresAt <= System.currentTimeMillis() }) save()
        return entries.values.toList()
    }

    @Synchronized fun removeSessionCookies(): Boolean {
        val removed = entries.entries.removeAll { !it.value.persistent }
        save()
        return removed
    }

    @Synchronized fun flushPreferences() { save() }

    @Synchronized fun remove(uri: URI) {
        val url = uri.toString().toHttpUrlOrNull() ?: return
        // This source-facing overload clears a host's cookies, not just the URI path.
        entries.entries.removeAll {
            val cookie = it.value
            url.host == cookie.domain || (!cookie.hostOnly && url.host.endsWith(".${cookie.domain}"))
        }
        save()
    }

    private fun fromJava(uri: URI?, cookie: HttpCookie): Cookie? = runCatching {
        val domain = cookie.domain?.removePrefix(".") ?: uri?.host ?: return null
        val builder = Cookie.Builder().name(cookie.name).value(cookie.value).path(cookie.path ?: "/")
        if (cookie.domain == null || !cookie.domain.startsWith('.')) builder.hostOnlyDomain(domain) else builder.domain(domain)
        if (cookie.secure) builder.secure()
        if (cookie.isHttpOnly) builder.httpOnly()
        if (cookie.maxAge >= 0) {
            val now = System.currentTimeMillis()
            builder.expiresAt(if (cookie.maxAge > (Long.MAX_VALUE - now) / 1000) Long.MAX_VALUE else now + cookie.maxAge * 1000)
        }
        builder.build()
    }.getOrNull()

    private fun toJava(cookie: Cookie) = HttpCookie(cookie.name, cookie.value).apply {
        domain = (if (cookie.hostOnly) "" else ".") + cookie.domain
        path = cookie.path; secure = cookie.secure; isHttpOnly = cookie.httpOnly
        maxAge = if (cookie.persistent) maxOf(0L, (cookie.expiresAt - System.currentTimeMillis()) / 1000) else -1L
    }

    @Synchronized override fun add(uri: URI?, cookie: HttpCookie) {
        val converted = fromJava(uri, cookie) ?: return
        val url = uri?.toString()?.toHttpUrlOrNull()
        if (url != null) addAll(url, listOf(converted)) else { entries[key(converted)] = converted; save() }
    }
    override fun get(uri: URI): List<HttpCookie> = uri.toString().toHttpUrlOrNull()?.let { get(it).map(::toJava) } ?: emptyList()
    override fun getCookies(): List<HttpCookie> = getStoredCookies().map(::toJava)
    override fun getURIs(): List<URI> = getStoredCookies().map { URI("https", null, it.domain, -1, "/", null, null) }.distinct()
    @Synchronized override fun remove(uri: URI?, cookie: HttpCookie): Boolean {
        val converted = fromJava(uri, cookie) ?: return false
        val removed = entries.remove(key(converted)) != null
        if (removed) save()
        return removed
    }
    @Synchronized override fun removeAll(): Boolean {
        val changed = entries.isNotEmpty()
        entries.clear(); save()
        return changed
    }
}
