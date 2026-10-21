package suwayomi.browser

import android.content.Context
import android.content.SharedPreferences
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.ValueCallback
import eu.kanade.tachiyomi.network.PersistentCookieStore
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.atomic.AtomicReference

object WebkitCookieSmoke {
    @JvmStatic fun verify(): String {
        val context = object : Context() {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                super.getSharedPreferences("webkit-cookie-smoke", mode)
        }
        val prefs = context.getSharedPreferences("cookie_store", 0)
        prefs.edit().clear().commit()
        val store = PersistentCookieStore(context)
        val oldStore = CookieManager.bindCookieStore(store)
        val manager = CookieManager.getInstance()
        val oldAccept = manager.acceptCookie()
        try {
            manager.setAcceptCookie(true)
            val url = "https://cookies.example.test/reader/chapter"
            manager.setCookie(url, "same=root; Path=/; Max-Age=3600; Secure; HttpOnly")
            manager.setCookie(url, "same=reader; Path=/reader; Max-Age=3600; Secure")
            manager.setCookie(url, "domain=shared; Domain=example.test; Path=/; Max-Age=3600")
            manager.setCookie(url, "session=temporary; Path=/")
            check(manager.getCookie(url) == "same=reader; same=root; domain=shared; session=temporary")
            check(manager.getCookie("http://cookies.example.test/reader") == "domain=shared; session=temporary")
            check(manager.getCookie("https://sub.cookies.example.test/") == "domain=shared")
            check(manager.getCookie("https://notexample.test/") == null)
            check(store.get(url.toHttpUrl()).size == 4)
            store.addAll(url.toHttpUrl(), listOf(Cookie.parse(url.toHttpUrl(), "network=shared; Path=/")!!))
            check(manager.getCookie(url)!!.contains("network=shared"))
            manager.setCookie("http://cookies.example.test/", "bad=secure; Secure")
            manager.setCookie(url, "bad=foreign; Domain=other.test")
            manager.setCookie(url, "bad=suffix; Domain=test")
            manager.setCookie(url, "bad=partition; Secure; Partitioned")
            manager.setCookie(url, "__Host-bad=value; Secure; Domain=cookies.example.test; Path=/")
            manager.setCookie(url, "__Secure-bad=value")
            check(store.getStoredCookies().none { it.name == "bad" || it.name.endsWith("-bad") })
            manager.setCookie(url, "__Host-good=value; Secure; Path=/; Max-Age=3600")
            check(manager.getCookie(url)!!.contains("__Host-good=value"))
            manager.flush()
            check(!prefs.getString("browser.cookies.v1", "")!!.contains("temporary"))
            manager.removeSessionCookies(null)
            check(manager.getCookie(url)!!.contains("same=root") && !manager.getCookie(url)!!.contains("temporary"))
            check(!manager.getCookie(url)!!.contains("network=shared"))
            manager.setCookie(url, "same=gone; Path=/reader; Max-Age=0")
            check(!manager.getCookie(url)!!.contains("same=reader"))
            manager.setAcceptCookie(false)
            manager.setCookie(url, "disabled=value")
            check(!manager.getCookie(url)!!.contains("disabled=value"))
            manager.setAcceptCookie(true)
            check(!CookieManager.allowFileSchemeCookies())
            check(runCatching { CookieManager.setAcceptFileSchemeCookies(true) }.exceptionOrNull() is UnsupportedOperationException)
            check(manager.getCookie("file:///data/test") == null)

            val failure = AtomicReference<Throwable?>()
            val callbackThread = Thread {
                try {
                    Looper.prepare()
                    val looper = Looper.myLooper()!!
                    var returned = false
                    val callbacks = mutableListOf<Boolean>()
                    fun record(value: Boolean) {
                        check(returned && looper.isCurrentThread)
                        callbacks.add(value)
                    }
                    manager.setCookie(url, "callback=persistent; Path=/; Max-Age=3600", ValueCallback { record(it) })
                    returned = true
                    manager.removeSessionCookies(ValueCallback { record(it) })
                    manager.removeAllCookies(ValueCallback { record(it) })
                    manager.removeAllCookies(ValueCallback { record(it); looper.quitSafely() })
                    check(callbacks.isEmpty()) // asynchronous, not an inline imitation
                    Looper.loop()
                    check(callbacks == listOf(true, false, true, false))
                } catch (error: Throwable) { failure.set(error) }
            }
            callbackThread.start(); callbackThread.join()
            failure.get()?.let { throw it }
            val noLooper = Thread {
                try {
                    val result = runCatching { manager.setCookie(url, "noLooper=value", ValueCallback {}) }
                    check(result.isFailure)
                    check(manager.getCookie(url) == null)
                } catch (error: Throwable) { failure.set(error) }
            }
            noLooper.start(); noLooper.join()
            failure.get()?.let { throw it }
            check(!manager.hasCookies())
            return "Webkit CookieManager: shared source jar, scope/secure/expiry, session deletion, local flush and asynchronous caller-Looper callbacks verified"
        } finally {
            manager.setAcceptCookie(oldAccept)
            CookieManager.bindCookieStore(oldStore)
            prefs.edit().clear().commit()
        }
    }
}
