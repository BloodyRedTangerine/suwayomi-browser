package eu.kanade.tachiyomi.network
import android.content.Context
import app.cash.quickjs.QuickJs
class JavaScriptEngine(context: Context) {
    @Suppress("UNCHECKED_CAST")
    suspend fun <T> evaluate(script: String): T = QuickJs.create().use { it.evaluate(script) as T }
}
