package suwayomi.browser

import okhttp3.*
import okhttp3.internal.http.HttpMethod
import java.net.ProtocolException

/** Redirect/auth follow-ups without OkHttp socket exchanges. No speculative I/O retries. */
object BrowserFollowUps : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        var previous: Response? = null
        var count = 0
        while (true) {
            // Application interceptors run once; network interceptors and the
            // transport run for every hop. Do not carry auto-added jar cookies.
            val response = chain.proceed(request).newBuilder().request(request).priorResponse(previous).build()
            val next = try { when (response.code) {
                300, 301, 302, 303, 307, 308 -> redirect(chain, response)
                401 -> chain.authenticator.authenticate(null, response)
                407 -> throw ProtocolException("Browser transport does not support proxy authentication")
                else -> null
            } } catch (error: Throwable) { response.close(); throw error }
            if (next == null || next.body?.isOneShot() == true) return response
            if (++count > 20) { response.close(); throw ProtocolException("Too many follow-up requests: $count") }
            val oldType = response.body.contentType()
            val oldLength = response.body.contentLength()
            // Preserve history metadata, never retain readable prior response bytes.
            val metadata = object : ResponseBody() {
                override fun contentType() = oldType
                override fun contentLength() = oldLength
                override fun source(): okio.BufferedSource = throw IllegalStateException("Prior response body is not readable")
                override fun close() {}
            }
            previous = response.newBuilder().body(metadata).build()
            response.close()
            request = next
        }
    }

    private fun redirect(chain: Interceptor.Chain, response: Response): Request? {
        if (!chain.followRedirects) return null
        val original = response.request
        val target = response.header("Location")?.let { original.url.resolve(it) } ?: return null
        if (target.scheme != original.url.scheme && !chain.followSslRedirects) return null
        val next = original.newBuilder().url(target)
        if (HttpMethod.permitsRequestBody(original.method) && HttpMethod.redirectsToGet(original.method, response.code)) {
            next.method("GET", null).removeHeader("Transfer-Encoding").removeHeader("Content-Length").removeHeader("Content-Type")
        }
        if (original.url.scheme != target.scheme || original.url.host != target.host || original.url.port != target.port) {
            next.removeHeader("Authorization").removeHeader("Proxy-Authorization").removeHeader("Cookie").removeHeader("Host")
        }
        return next.build()
    }
}
