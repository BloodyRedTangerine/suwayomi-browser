package suwayomi.browser

import android.content.Context
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.POST
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.IOException

object RequestBodySmoke {
    private val media = "application/json; charset=utf-8".toMediaType()
    @JvmStatic fun verify() {
        fun execute(body: RequestBody, headers: Headers = Headers.Builder().build()): Request {
            var network: Request? = null
            val client = OkHttpClient.Builder().addInterceptor {
                check(it.request().header("Content-Type") == headers["Content-Type"])
                it.proceed(it.request())
            }.addNetworkInterceptor {
                network = it.request()
                Response.Builder().request(it.request()).protocol(Protocol.HTTP_1_1).code(200).message("fixture").body("ok".toResponseBody()).build()
            }.build()
            BrowserCall(client, POST("https://body.example.test/", headers, body)).execute().close()
            return network ?: error("Network interceptor did not execute")
        }
        val form = FormBody.Builder().add("q", "Café & +").build()
        val formRequest = execute(form, Headers.Builder().add("Content-Length", "999").add("Transfer-Encoding", "broken").build())
        check(formRequest.header("Content-Type") == "application/x-www-form-urlencoded")
        check(formRequest.header("Content-Length") == form.contentLength().toString() && formRequest.header("Transfer-Encoding") == null)
        val json = "{}".toRequestBody(media)
        check(execute(json, Headers.Builder().add("Content-Type", "wrong").build()).header("Content-Type") == media.toString())
        val unknown = object : RequestBody() {
            override fun contentType(): MediaType? = null
            override fun writeTo(sink: okio.BufferedSink) { sink.writeUtf8("streamed") }
        }
        val unknownRequest = execute(unknown, Headers.Builder().add("Content-Length", "999").add("Content-Type", "source-specific").build())
        check(unknownRequest.header("Content-Length") == null && unknownRequest.header("Transfer-Encoding") == "chunked")
        check(unknownRequest.header("Content-Type") == "source-specific")
        check(execute(FormBody.Builder().build()).header("Content-Length") == "0")
        for (duplex in listOf(true, false)) {
            val invalid = object : RequestBody() {
                override fun contentType(): MediaType? = null
                override fun isDuplex() = duplex
                override fun contentLength() = -2L
                override fun writeTo(sink: okio.BufferedSink) { error("Must not write unsupported body") }
            }
            check(runCatching { execute(invalid) }.exceptionOrNull() is IOException)
        }
        println("Request bridge: form/JSON metadata, known/unknown/empty lengths, overrides and unsupported duplex bodies verified")
    }

    /** Uses real source-facing request helpers and the patched client's browser I/O. */
    @JvmStatic fun roundTrip(): String {
        val client = NetworkHelper(Context()).client
        fun send(path: String, body: RequestBody, expected: ByteArray? = null) {
            val bytes = expected ?: Buffer().apply { body.writeTo(this) }.readByteArray()
            client.newCall(POST("https://body.example.test/$path", body = body)).execute().use {
                check(it.isSuccessful && it.body.bytes().contentEquals(bytes)) { "Browser round-trip body mismatch: $path" }
            }
        }
        send("form", FormBody.Builder().add("q", "Café & +").add("page", "2").build())
        send("json", """{"title":"Café","number":42}""".toRequestBody(media))
        val binary = byteArrayOf(0, -128, -1)
        send("binary", binary.toRequestBody("application/octet-stream".toMediaType()))
        send("multipart", MultipartBody.Builder("browser-test-boundary").setType(MultipartBody.FORM)
            .addFormDataPart("q", "Café")
            .addFormDataPart("file", "fixture.bin", binary.toRequestBody("application/octet-stream".toMediaType())).build())
        val stream = "streamed".toByteArray(Charsets.UTF_8)
        send("unknown", object : RequestBody() {
            override fun contentType() = "text/plain".toMediaType()
            override fun writeTo(sink: okio.BufferedSink) { sink.write(stream) }
        }, stream)
        var writes = 0
        send("one-shot", object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = binary.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: okio.BufferedSink) { check(++writes == 1); sink.write(binary) }
        }, binary)
        check(writes == 1)
        send("empty", FormBody.Builder().build())
        client.newCall(POST("https://body.example.test/redirect303", body = FormBody.Builder().add("q", "dummy").build())).execute().use {
            check(it.code == 200 && it.request.method == "GET" && it.body.string() == "redirect-ok")
        }
        val malformed = object : RequestBody() {
            override fun contentType(): MediaType? = null
            override fun contentLength() = 2L
            override fun writeTo(sink: okio.BufferedSink) { sink.write(binary) }
        }
        check(runCatching { client.newCall(POST("https://body.example.test/malformed", body = malformed)).execute() }.exceptionOrNull() is java.net.ProtocolException)
        return "Request-body browser round trips verified"
    }
}
