package suwayomi.browser

import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/** The JS worker drains requests and returns browser-fetch responses. */
object BrowserTransport : Interceptor {
    private val ids = AtomicInteger()
    private val pending = ConcurrentLinkedQueue<JsonObject>()
    private val responses = ConcurrentHashMap<Int, JsonObject>()
    private val scriptContexts = AtomicInteger()

    @JvmStatic fun newScriptContext(): Int = scriptContexts.incrementAndGet()
    @JvmStatic fun image(command: String): String {
        val id = ids.incrementAndGet()
        val request = Json.parseToJsonElement(command).jsonObject
        pending.add(buildJsonObject { request.forEach { (key, value) -> put(key, value) }; put("id", id); put("kind", "image") })
        val deadline = System.currentTimeMillis() + 30_000
        try {
            while (true) {
                val response = responses.remove(id)
                if (response != null) return response.toString()
                if (System.currentTimeMillis() > deadline) throw IOException("Browser image operation timed out")
                Thread.sleep(10)
            }
        } finally { responses.remove(id) }
    }
    @JvmStatic fun script(context: Int, script: String, action: String): String {
        val id = ids.incrementAndGet()
        pending.add(buildJsonObject { put("id", id); put("kind", "script"); put("context", context); put("script", script); put("action", action) })
        val deadline = System.currentTimeMillis() + 30_000
        while (true) {
            val response = responses.remove(id)
            if (response != null) return response.toString()
            if (System.currentTimeMillis() > deadline) throw IOException("Script evaluation timed out")
            Thread.sleep(10)
        }
    }

    @JvmStatic fun webView(command: String): String {
        val id = ids.incrementAndGet()
        val request = Json.parseToJsonElement(command).jsonObject
        pending.add(buildJsonObject { request.forEach { (key, value) -> put(key, value) }; put("id", id); put("kind", "webview") })
        val deadline = System.currentTimeMillis() + 120_000
        try {
            while (true) {
                val response = responses.remove(id)
                if (response != null) return response.toString()
                if (System.currentTimeMillis() > deadline) throw IOException("Browser WebView operation timed out")
                Thread.sleep(10)
            }
        } finally { responses.remove(id) }
    }

    @JvmStatic fun drain(): String = buildJsonArray {
        while (true) { val item = pending.poll() ?: break; add(item) }
    }.toString()

    @JvmStatic fun respond(id: Int, response: String) {
        responses[id] = Json.parseToJsonElement(response).jsonObject
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        // Match after source interceptors have finished rewriting the target URL.
        val original = chain.request()
        val cookies = chain.cookieJar.loadForRequest(original.url)
        val request = if (cookies.isEmpty()) original else original.newBuilder()
            .header("Cookie", cookies.joinToString("; ") { "${it.name}=${it.value}" }).build()
        val id = ids.incrementAndGet()
        val body = Buffer()
        val expectedLength = request.body?.contentLength() ?: -1L
        if (request.body?.isDuplex() == true) throw IOException("Duplex request bodies are not supported by browser Fetch transport")
        if (expectedLength < -1) throw IOException("Invalid request body length")
        request.body?.writeTo(body)
        if (expectedLength >= 0 && expectedLength != body.size) throw java.net.ProtocolException("Request body length does not match its declared length")
        pending.add(buildJsonObject {
            put("id", id); put("kind", "fetch"); put("url", request.url.toString()); put("method", request.method)
            put("headers", buildJsonArray { for (i in 0 until request.headers.size) add(buildJsonArray { add(request.headers.name(i)); add(request.headers.value(i)) }) })
            put("body", Base64.getEncoder().encodeToString(body.readByteArray()))
        })
        val deadline = System.currentTimeMillis() + 120_000
        var payload: JsonObject? = null
        try {
            while (payload == null) {
                if (chain.call().isCanceled()) throw IOException("Canceled")
                if (System.currentTimeMillis() > deadline) throw IOException("Browser request timed out")
                payload = responses.remove(id)
                if (payload == null) Thread.sleep(10)
            }
            payload["error"]?.jsonPrimitive?.contentOrNull?.let { throw IOException(it) }
            val headers = Headers.Builder()
            payload["headers"]?.jsonArray?.forEach { val pair = it.jsonArray; headers.add(pair[0].jsonPrimitive.content, pair[1].jsonPrimitive.content) }
            val bytes = Base64.getDecoder().decode(payload["body"]!!.jsonPrimitive.content)
            val builtHeaders = headers.build()
            val finalRequest = payload["url"]?.jsonPrimitive?.contentOrNull?.let { request.newBuilder().url(it).build() } ?: request
            val response = Response.Builder().request(finalRequest).protocol(Protocol.HTTP_1_1)
                .code(payload["status"]!!.jsonPrimitive.int).message(payload["statusText"]?.jsonPrimitive?.content ?: "")
                .headers(builtHeaders).body(bytes.toResponseBody(builtHeaders["Content-Type"]?.toMediaTypeOrNull())).build()
            // The installed broker observes only this source request's response headers.
            // Never invent a login or copy browser-profile cookies.
            val received = Cookie.parseAll(response.request.url, response.headers)
            if (received.isNotEmpty()) chain.cookieJar.saveFromResponse(response.request.url, received)
            return response
        } finally { responses.remove(id) }
    }
}
