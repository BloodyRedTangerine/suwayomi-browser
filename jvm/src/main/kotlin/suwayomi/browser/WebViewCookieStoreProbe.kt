package suwayomi.browser

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import eu.kanade.tachiyomi.network.PersistentCookieStore

/** Isolated source-cookie jar for the browser-backed WebView integration probe. */
object WebViewCookieStoreProbe {
    private const val PREFERENCE_PREFIX = "webview-sri-probe"

    @JvmStatic fun bind(): PersistentCookieStore? {
        val context = object : Context() {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                super.getSharedPreferences("$PREFERENCE_PREFIX-$name", mode)
        }
        context.getSharedPreferences("cookie_store", Context.MODE_PRIVATE).edit().clear().commit()
        return CookieManager.bindCookieStore(PersistentCookieStore(context))
    }

    @JvmStatic fun restore(previous: PersistentCookieStore?) {
        CookieManager.bindCookieStore(previous)
        val context = object : Context() {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                super.getSharedPreferences("$PREFERENCE_PREFIX-$name", mode)
        }
        context.getSharedPreferences("cookie_store", Context.MODE_PRIVATE).edit().clear().commit()
    }
}
