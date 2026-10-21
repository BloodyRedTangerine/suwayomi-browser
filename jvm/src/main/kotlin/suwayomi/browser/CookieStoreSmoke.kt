package suwayomi.browser

import android.content.Context
import eu.kanade.tachiyomi.network.PersistentCookieJar
import eu.kanade.tachiyomi.network.PersistentCookieStore
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.net.HttpCookie
import java.net.URI

object CookieStoreSmoke {
    @JvmStatic fun verify() {
        val before = Context.exportPreferences()
        try {
            val context = Context()
            context.getSharedPreferences("cookie_store", 0).edit().clear().commit()
            val store = PersistentCookieStore(context)
            val url = "https://cookies.example.test/reader/chapter".toHttpUrl()
            fun parse(text: String) = Cookie.parse(url, text) ?: error("Invalid fixture cookie")
            check(Cookie.parse("https://cookies.example.com/".toHttpUrl(), "bad=dummy; Domain=com") == null) { "Public-suffix cookie was accepted" }
            check(Cookie.parse("https://cookies.example.co.uk/".toHttpUrl(), "bad=dummy; Domain=co.uk") == null) { "Multi-label public-suffix cookie was accepted" }
            val jar = PersistentCookieJar(store)
            jar.saveFromResponse(url, listOf(
                parse("same=root; Path=/; Max-Age=3600; Secure; HttpOnly"),
                parse("same=reader; Path=/reader; Max-Age=3600; Secure"),
                parse("domain=shared; Domain=example.test; Path=/; Max-Age=3600"),
                parse("session=temporary; Path=/"),
            ))
            check(jar.loadForRequest(url).map { it.value } == listOf("reader", "root", "shared", "temporary"))
            check(store.get("https://cookies.example.test/readership".toHttpUrl()).none { it.value == "reader" })
            check(store.get("http://cookies.example.test/reader".toHttpUrl()).none { it.secure })
            check(store.get("https://sub.cookies.example.test/reader".toHttpUrl()).map { it.name } == listOf("domain"))
            check(store.get("https://notexample.test/".toHttpUrl()).isEmpty())
            val saved = Context.exportPreferences()
            check(!saved.contains("temporary")) { "Session cookie was persisted" }
            Context.restorePreferences(saved)
            val cold = PersistentCookieStore(Context())
            check(cold.get(url).size == 3 && cold.get(url).count { it.name == "same" } == 2)
            check(cold.getStoredCookies().first { it.value == "root" }.let { it.hostOnly && it.httpOnly && it.secure && it.persistent })
            val invalid = Cookie.Builder().name("foreign").value("dummy").domain("other.test").build()
            check(runCatching { cold.addAll(url, listOf(parse("new=dummy"), invalid)) }.isFailure)
            check(cold.getStoredCookies().none { it.name == "new" }) { "Invalid batch was partly committed" }
            cold.addAll(url, listOf(parse("same=deleted; Path=/reader; Max-Age=0")))
            check(cold.get(url).count { it.name == "same" } == 1)
            val javaCookie = HttpCookie("java", "dummy").apply { path = "/reader"; isHttpOnly = true; secure = true; maxAge = 3600 }
            cold.add(URI(url.toString()), javaCookie)
            check(cold.get(URI(url.toString())).first { it.name == "java" }.let { it.maxAge in 3590..3600 && it.isHttpOnly && it.secure })
            check(cold.getCookies().none { it.maxAge == -1L })
            check(cold.getURIs().size == 2)
            check(cold.remove(URI(url.toString()), javaCookie))
            check(!cold.remove(URI(url.toString()), javaCookie))
            val session = HttpCookie("session", "dummy")
            cold.add(URI(url.toString()), session)
            check(cold.getCookies().first { it.name == "session" }.maxAge == -1L)
            cold.remove(URI("http://cookies.example.test/other-path"))
            check(cold.getStoredCookies().isEmpty())
            check(!cold.removeAll())
            cold.addAll(url, listOf(parse("clear=dummy")))
            check(cold.removeAll() && !cold.removeAll())
            check(PersistentCookieStore(Context()).getStoredCookies().isEmpty())
            println("Source cookie store: host/domain/path/secure/expiry matching, persistent cold restore, session isolation, Java API and deletion verified")
        } finally { Context.restorePreferences(before) }
    }
}
