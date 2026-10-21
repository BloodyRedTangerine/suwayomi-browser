package suwayomi.browser

import okhttp3.*
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import java.net.ProtocolException
import java.util.concurrent.TimeUnit

object FollowUpSmoke {
    @JvmStatic fun verify() {
        fun reply(request: Request, status: Int = 200, location: String? = null): Response = Response.Builder()
            .request(request).protocol(Protocol.HTTP_1_1).code(status).message("fixture")
            .body("synthetic response".toResponseBody()).apply { if (location != null) header("Location", location) }.build()
        val original = Request.Builder().url("https://follow.example.test/start").build()
        var applications = 0
        val seen = mutableListOf<Request>()
        fun execute(request: Request = original, builder: OkHttpClient.Builder = OkHttpClient.Builder(), network: (Request) -> Response): Response {
            seen.clear(); applications = 0
            val client = builder.addInterceptor { applications++; it.proceed(it.request()) }
                .addNetworkInterceptor { seen.add(it.request()); network(it.request()) }.build()
            return BrowserCall(client, request).execute()
        }
        execute { request -> if (seen.size == 1) reply(request, 302, "../final?ok=1") else reply(request) }.use { response ->
            check(applications == 1 && seen.size == 2)
            check(response.request.url.toString() == "https://follow.example.test/final?ok=1")
            check(response.priorResponse?.code == 302)
            check(runCatching { response.priorResponse!!.body.string() }.isFailure)
        }
        for (code in listOf(300, 301, 302, 303, 307, 308)) {
            val post = original.newBuilder().post("dummy".toRequestBody()).header("Content-Type", "text/plain").header("Content-Length", "5").build()
            execute(post) { request -> if (seen.size == 1) reply(request, code, "/final") else reply(request) }.close()
            val preservesBody = code == 307 || code == 308
            check(seen[1].method == if (preservesBody) "POST" else "GET")
            check((seen[1].body != null) == preservesBody)
            check((seen[1].header("Content-Type") != null) == preservesBody)
            check((seen[1].header("Content-Length") != null) == preservesBody)
        }
        for (method in listOf("QUERY", "PROPFIND")) {
            val request = original.newBuilder().method(method, "dummy".toRequestBody()).build()
            execute(request) { if (seen.size == 1) reply(it, 302, "/final") else reply(it) }.close()
            check(seen[1].method == method)
        }
        execute(builder = OkHttpClient.Builder().followRedirects(false)) { reply(it, 302, "/final") }.use { check(it.code == 302 && seen.size == 1) }
        execute(builder = OkHttpClient.Builder().followSslRedirects(false)) { reply(it, 302, "http://follow.example.test/final") }.use { check(it.code == 302 && seen.size == 1) }
        execute { reply(it, 302, "file:///private") }.use { check(it.code == 302 && seen.size == 1) }
        execute { reply(it, 302) }.use { check(it.code == 302 && seen.size == 1) }
        val credentials = original.newBuilder().header("Authorization", "dummy").header("Proxy-Authorization", "dummy")
            .header("Cookie", "explicit=dummy").header("Host", "follow.example.test").build()
        for (target in listOf("https://elsewhere.test/final", "https://follow.example.test:444/final", "http://follow.example.test/final")) {
            execute(credentials) { if (seen.size == 1) reply(it, 302, target) else reply(it) }.close()
            for (name in listOf("Authorization", "Proxy-Authorization", "Cookie", "Host")) check(seen[1].header(name) == null)
        }
        execute(credentials) { if (seen.size == 1) reply(it, 302, "/same-origin") else reply(it) }.close()
        check(seen[1].header("Authorization") == "dummy" && seen[1].header("Cookie") == "explicit=dummy")
        val once = object : RequestBody() {
            override fun contentType(): MediaType? = null
            override fun isOneShot() = true
            override fun writeTo(sink: okio.BufferedSink) { sink.writeUtf8("dummy") }
        }
        execute(original.newBuilder().post(once).build()) { reply(it, 307, "/final") }.use { check(it.code == 307 && seen.size == 1) }
        check(runCatching { execute { reply(it, 302, "/loop") } }.exceptionOrNull() is ProtocolException)
        check(seen.size == 21)
        var authCalls = 0
        execute(builder = OkHttpClient.Builder().authenticator { route, response ->
            check(route == null); authCalls++; response.request.newBuilder().header("Authorization", "dummy").build()
        }) { if (it.header("Authorization") == null) reply(it, 401) else reply(it) }.use {
            check(it.code == 200 && authCalls == 1 && it.priorResponse?.code == 401)
        }
        check(runCatching { execute { reply(it, 407) } }.exceptionOrNull() is ProtocolException)
        // withTimeout must not discard a previously customized chain cookie jar.
        val jar = object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {}
            override fun loadForRequest(url: HttpUrl) = emptyList<Cookie>()
        }
        val client = OkHttpClient.Builder().addInterceptor { it.withCookieJar(jar).withReadTimeout(3, TimeUnit.SECONDS).proceed(it.request()) }
            .addNetworkInterceptor { check(it.cookieJar === jar && it.readTimeoutMillis() == 3000); reply(it.request()) }.build()
        BrowserCall(client, original).execute().close()
        println("Browser follow-ups: redirect methods/history, limits, client flags, credential isolation, one-shot bodies, authenticator and chain configuration verified")
    }
}
