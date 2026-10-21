package eu.kanade.tachiyomi

/** Host identity for source headers. Does not impersonate an Android Mihon app. */
object AppInfo {
    fun getVersionCode(): Int = 228
    fun getVersionName(): String = "0.2.28-browser"
    fun getSupportedImageMimeTypes(): List<String> = listOf("image/jpeg", "image/png", "image/gif", "image/webp")
}
