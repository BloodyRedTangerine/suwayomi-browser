package eu.kanade.tachiyomi.network

import android.content.Context
import eu.kanade.tachiyomi.network.interceptor.UncaughtExceptionInterceptor
import eu.kanade.tachiyomi.network.interceptor.UserAgentInterceptor
import eu.kanade.tachiyomi.network.interceptor.CloudflareInterceptor
import okhttp3.OkHttpClient
import suwayomi.browser.BrowserTransport
import java.util.concurrent.TimeUnit

/** Source-compatible replacement for the desktop network helper. */
class NetworkHelper(context: Context) {
    val cookieStore = PersistentCookieStore(context)
    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(PersistentCookieJar(cookieStore))
        .callTimeout(120, TimeUnit.SECONDS)
        .addInterceptor(UncaughtExceptionInterceptor())
        .addInterceptor(UserAgentInterceptor(::defaultUserAgentProvider))
        .addInterceptor(CloudflareInterceptor())
        .addInterceptor(BrowserTransport)
        .build()
    val cloudflareClient: OkHttpClient get() = client
    fun defaultUserAgentProvider(): String = "Suwayomi Browser"
}
