package suwayomi.browser

import okhttp3.*
import okio.Timeout
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.reflect.KClass
import javax.net.SocketFactory
import javax.net.ssl.*
import java.net.Proxy
import java.net.ProxySelector

/** OkHttp's source-facing API with browser transport replacing socket I/O. */
class BrowserCall(private val client: OkHttpClient, private val original: Request) : Call {
    private val executed = AtomicBoolean()
    @Volatile private var canceled = false
    private val callTimeout = Timeout().timeout(client.callTimeoutMillis.toLong(), TimeUnit.MILLISECONDS)
    private val listeners = mutableListOf<EventListener>()
    private val tags = mutableMapOf<Class<*>, Any>()
    override fun addEventListener(eventListener: EventListener) { listeners.add(eventListener) }
    @Suppress("UNCHECKED_CAST")
    override fun <T> tag(type: Class<out T>): T? = (tags[type] ?: original.tag(type)) as T?
    override fun <T : Any> tag(type: KClass<T>): T? = tag(type.java)
    override fun <T : Any> tag(type: Class<T>, computeIfAbsent: () -> T): T = tag(type) ?: computeIfAbsent().also { tags[type] = it }
    override fun <T : Any> tag(type: KClass<T>, computeIfAbsent: () -> T): T = tag(type.java, computeIfAbsent)
    override fun request(): Request = original
    override fun timeout(): Timeout = callTimeout
    override fun cancel() { canceled = true }
    override fun isCanceled(): Boolean = canceled
    override fun isExecuted(): Boolean = executed.get()
    override fun clone(): Call = BrowserCall(client, original)

    override fun execute(): Response {
        check(executed.compareAndSet(false, true)) { "Already Executed" }
        if (canceled) throw IOException("Canceled")
        val interceptors = client.interceptors.filterNot { it === BrowserTransport } + BrowserFollowUps + BrowserRequestBridge + client.networkInterceptors + BrowserTransport
        return Chain(interceptors, 0, original, client.connectTimeoutMillis, client.readTimeoutMillis, client.writeTimeoutMillis).proceed(original)
    }
    override fun enqueue(callback: Callback) {
        Thread {
            try { callback.onResponse(this, execute()) }
            catch (error: Exception) { callback.onFailure(this, if (error is IOException) error else IOException(error.message, error)) }
        }.apply { isDaemon = true; start() }
    }

    private inner class Chain(
        private val interceptors: List<Interceptor>, private val index: Int,
        private val request: Request, private val connect: Int, private val read: Int, private val write: Int,
        private val configuration: OkHttpClient = client,
    ) : Interceptor.Chain {
        override fun request(): Request = request
        override fun call(): Call = this@BrowserCall
        override fun connection(): Connection? = null
        override val followSslRedirects get() = configuration.followSslRedirects
        override val followRedirects get() = configuration.followRedirects
        override val dns get() = configuration.dns
        override val socketFactory get() = configuration.socketFactory
        override val retryOnConnectionFailure get() = configuration.retryOnConnectionFailure
        override val authenticator get() = configuration.authenticator
        override val cookieJar get() = configuration.cookieJar
        override val cache get() = configuration.cache
        override val proxy get() = configuration.proxy
        override val proxySelector get() = configuration.proxySelector
        override val proxyAuthenticator get() = configuration.proxyAuthenticator
        override val sslSocketFactoryOrNull get() = configuration.sslSocketFactory
        override val x509TrustManagerOrNull get() = configuration.x509TrustManager
        override val hostnameVerifier get() = configuration.hostnameVerifier
        override val certificatePinner get() = configuration.certificatePinner
        override val connectionPool get() = configuration.connectionPool
        override val eventListener: EventListener = EventListener.NONE
        private fun configure(block: OkHttpClient.Builder.() -> Unit): Interceptor.Chain =
            Chain(interceptors, index, request, connect, read, write, configuration.newBuilder().apply(block).build())
        override fun withDns(dns: Dns) = configure { dns(dns) }
        override fun withSocketFactory(socketFactory: SocketFactory) = configure { socketFactory(socketFactory) }
        override fun withRetryOnConnectionFailure(retryOnConnectionFailure: Boolean) = configure { retryOnConnectionFailure(retryOnConnectionFailure) }
        override fun withAuthenticator(authenticator: Authenticator) = configure { authenticator(authenticator) }
        override fun withCookieJar(cookieJar: CookieJar) = configure { cookieJar(cookieJar) }
        override fun withCache(cache: Cache?) = configure { cache(cache) }
        override fun withProxy(proxy: Proxy?) = configure { proxy(proxy) }
        override fun withProxySelector(proxySelector: ProxySelector) = configure { proxySelector(proxySelector) }
        override fun withProxyAuthenticator(proxyAuthenticator: Authenticator) = configure { proxyAuthenticator(proxyAuthenticator) }
        override fun withSslSocketFactory(sslSocketFactory: SSLSocketFactory?, x509TrustManager: X509TrustManager?) = configure {
            require(sslSocketFactory != null && x509TrustManager != null) { "SSL factory and trust manager are required" }
            sslSocketFactory(sslSocketFactory, x509TrustManager)
        }
        override fun withHostnameVerifier(hostnameVerifier: HostnameVerifier) = configure { hostnameVerifier(hostnameVerifier) }
        override fun withCertificatePinner(certificatePinner: CertificatePinner) = configure { certificatePinner(certificatePinner) }
        override fun withConnectionPool(connectionPool: ConnectionPool) = configure { connectionPool(connectionPool) }
        override fun connectTimeoutMillis(): Int = connect
        override fun readTimeoutMillis(): Int = read
        override fun writeTimeoutMillis(): Int = write
        override fun withConnectTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = Chain(interceptors, index, request, unit.toMillis(timeout.toLong()).toInt(), read, write, configuration)
        override fun withReadTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = Chain(interceptors, index, request, connect, unit.toMillis(timeout.toLong()).toInt(), write, configuration)
        override fun withWriteTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = Chain(interceptors, index, request, connect, read, unit.toMillis(timeout.toLong()).toInt(), configuration)
        override fun proceed(request: Request): Response {
            if (canceled) throw IOException("Canceled")
            check(index < interceptors.size) { "No browser transport" }
            return interceptors[index].intercept(Chain(interceptors, index + 1, request, connect, read, write, configuration))
        }
    }
}
