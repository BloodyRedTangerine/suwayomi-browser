package android.webkit

import android.os.Looper
import eu.kanade.tachiyomi.network.PersistentCookieStore
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Source-owned cookie API only; never reads the browser profile's cookies.
 * WebView-specific third-party/partition policy is not implemented here.
 */
abstract class CookieManager {
    abstract fun setAcceptCookie(accept: Boolean)
    abstract fun acceptCookie(): Boolean
    abstract fun setCookie(url: String, value: String)
    abstract fun setCookie(url: String, value: String, callback: ValueCallback<Boolean>?)
    abstract fun getCookie(url: String): String?
    abstract fun removeSessionCookie()
    abstract fun removeSessionCookies(callback: ValueCallback<Boolean>?)
    abstract fun removeAllCookie()
    abstract fun removeAllCookies(callback: ValueCallback<Boolean>?)
    abstract fun hasCookies(): Boolean
    abstract fun removeExpiredCookie()
    abstract fun flush()
    open fun allowFileSchemeCookiesImpl(): Boolean = false
    open fun setAcceptFileSchemeCookiesImpl(accept: Boolean) {
        if (accept) throw UnsupportedOperationException("File-scheme cookies are not supported")
    }
    companion object {
        private val instance: CookieManager = LocalCookieManager()
        @Volatile internal var store: PersistentCookieStore? = null
        @JvmStatic fun getInstance(): CookieManager = instance
        @JvmStatic fun allowFileSchemeCookies(): Boolean = instance.allowFileSchemeCookiesImpl()
        @JvmStatic fun setAcceptFileSchemeCookies(accept: Boolean) = instance.setAcceptFileSchemeCookiesImpl(accept)
        @Synchronized internal fun bindCookieStore(value: PersistentCookieStore?): PersistentCookieStore? =
            store.also { store = value }
    }
}

private class LocalCookieManager : CookieManager() {
    @Volatile private var accepting = true
    private fun store() = CookieManager.store ?: error("Source cookie store is not initialized")
    private fun parseUrl(input: String): HttpUrl? = input.toHttpUrlOrNull()
    private fun callbackLooper(callback: ValueCallback<Boolean>?): Looper? =
        if (callback == null) null else Looper.myLooper() ?: error("Cookie callbacks require a Looper on the calling thread")
    private fun deliver(callback: ValueCallback<Boolean>?, looper: Looper?, value: Boolean) {
        if (callback != null) looper!!.enqueueCallback { callback.onReceiveValue(value) }
    }
    override fun setAcceptCookie(accept: Boolean) { accepting = accept }
    override fun acceptCookie(): Boolean = accepting
    override fun setCookie(url: String, value: String) = setCookie(url, value, null)
    override fun setCookie(url: String, value: String, callback: ValueCallback<Boolean>?) {
        val looper = callbackLooper(callback)
        val parsedUrl = parseUrl(url)
        val cookie = parsedUrl?.let { Cookie.parse(it, value) }
        // Do not silently turn partitioned cookies into unpartitioned cookies.
        val partitioned = value.split(';').drop(1).any { it.substringBefore('=').trim().equals("Partitioned", true) }
        val valid = accepting && parsedUrl != null && cookie != null && !partitioned &&
            (!cookie.secure || parsedUrl.isHttps) &&
            (!cookie.name.startsWith("__Secure-") || cookie.secure && parsedUrl.isHttps) &&
            (!cookie.name.startsWith("__Host-") || cookie.secure && parsedUrl.isHttps && cookie.hostOnly && cookie.path == "/")
        if (valid) store().addAll(parsedUrl!!, listOf(cookie!!))
        deliver(callback, looper, valid)
    }
    override fun getCookie(url: String): String? = parseUrl(url)?.let { target ->
        store().get(target).takeIf { it.isNotEmpty() }?.joinToString("; ") { "${it.name}=${it.value}" }
    }
    override fun removeSessionCookie() { store().removeSessionCookies() }
    override fun removeSessionCookies(callback: ValueCallback<Boolean>?) {
        val looper = callbackLooper(callback)
        deliver(callback, looper, store().removeSessionCookies())
    }
    override fun removeAllCookie() { store().removeAll() }
    override fun removeAllCookies(callback: ValueCallback<Boolean>?) {
        val looper = callbackLooper(callback)
        deliver(callback, looper, store().removeAll())
    }
    override fun hasCookies(): Boolean = store().getStoredCookies().isNotEmpty()
    override fun removeExpiredCookie() { store().getStoredCookies() }
    override fun flush() { store().flushPreferences() }
}
