package suwayomi.browser

import android.content.Context
import android.os.SystemClock
import android.preference.PreferenceManager
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.interceptor.CloudflareInterceptor
import eu.kanade.tachiyomi.network.interceptor.UncaughtExceptionInterceptor
import eu.kanade.tachiyomi.network.interceptor.UserAgentInterceptor
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import java.lang.reflect.Proxy

object NetworkCompatSmoke {
    @JvmStatic fun verify() {
        val context = Context()
        val preferences = PreferenceManager.getDefaultSharedPreferences(context)
        preferences.edit().putBoolean("network-smoke", true).commit()
        check(context.getSharedPreferences(context.packageName + "_preferences", 0).getBoolean("network-smoke", false))
        preferences.edit().remove("network-smoke").commit()
        val before = SystemClock.elapsedRealtime()
        SystemClock.sleep(2)
        check(SystemClock.elapsedRealtime() >= before)
        val names = NetworkHelper(context).client.interceptors.map { it.javaClass.simpleName }
        check(names.take(3) == listOf("UncaughtExceptionInterceptor", "UserAgentInterceptor", "CloudflareInterceptor"))
        val original = Request.Builder().url("https://compat.example.test/").build()
        var forwarded: Request? = null
        fun chain(request: Request = original, proceed: (Request) -> Response): Interceptor.Chain =
            Proxy.newProxyInstance(Interceptor.Chain::class.java.classLoader, arrayOf(Interceptor.Chain::class.java)) { _, method, args ->
                when (method.name) {
                    "request" -> request
                    "proceed" -> proceed(args!![0] as Request)
                    else -> error("Unexpected test chain method ${method.name}")
                }
            } as Interceptor.Chain
        fun response(request: Request, status: Int = 200, server: String = "fixture"): Response = Response.Builder()
            .request(request).protocol(Protocol.HTTP_1_1).code(status).message("fixture")
            .header("Server", server).body("fixture".toResponseBody()).build()
        UserAgentInterceptor { "Browser compatibility test" }.intercept(chain { forwarded = it; response(it) }).close()
        check(forwarded!!.header("User-Agent") == "Browser compatibility test")
        val custom = original.newBuilder().header("User-Agent", "Source-specific").build()
        UserAgentInterceptor { "default" }.intercept(chain(custom) { forwarded = it; response(it) }).close()
        check(forwarded!!.header("User-Agent") == "Source-specific")
        try {
            UncaughtExceptionInterceptor().intercept(chain { throw IllegalArgumentException("test") })
            error("Expected wrapped exception")
        } catch (expected: IOException) { check(expected.cause is IllegalArgumentException) }
        CloudflareInterceptor().intercept(chain { response(it) }).close()
        try {
            CloudflareInterceptor().intercept(chain { response(it, 403, "cloudflare") })
            error("Challenge was treated as source content")
        } catch (expected: IOException) { check(expected.message!!.contains("interactive source authentication")) }
        println("Browser network API: interceptor ordering, headers, errors, challenge detection, default preferences and monotonic clock verified")
    }
}
