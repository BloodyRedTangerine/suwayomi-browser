package eu.kanade.tachiyomi.network.interceptor

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/** Browser transport cannot run the desktop FlareSolverr service. Challenges
 * are detected and reported, never treated as source content or auto-solved. */
class CloudflareInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.header("cf-mitigated") == "challenge" ||
            (response.code in listOf(403, 503) && response.header("Server")?.lowercase() in listOf("cloudflare", "cloudflare-nginx"))) {
            response.close()
            throw IOException("Cloudflare challenge at ${chain.request().url.host}; interactive source authentication is not yet ported to the browser runtime")
        }
        return response
    }
}
