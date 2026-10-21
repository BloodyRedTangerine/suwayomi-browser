package suwayomi.browser

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/** Body-derived request metadata, at the normal pre-network-interceptor position.
 * Fetch owns actual HTTP framing; this does not provide streaming/socket parity. */
object BrowserRequestBridge : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val body = original.body ?: return chain.proceed(original)
        if (body.isDuplex()) throw IOException("Duplex request bodies are not supported by browser Fetch transport")
        val request = original.newBuilder()
        body.contentType()?.let { request.header("Content-Type", it.toString()) }
        val length = body.contentLength()
        if (length < -1) throw IOException("Invalid request body length")
        if (length >= 0) request.header("Content-Length", length.toString()).removeHeader("Transfer-Encoding")
        else request.header("Transfer-Encoding", "chunked").removeHeader("Content-Length")
        return chain.proceed(request.build())
    }
}
