package suwayomi.browser

import eu.kanade.tachiyomi.source.online.HttpSource

/** Synthetic source proving that restoration precedes source construction. */
class FileStateSource : HttpSource() {
    init { FilesystemProbe.constructorCheck() }
    override val id = 991064003L
    override val name = "Filesystem constructor fixture"
    override val lang = "en"
    override val supportsLatest = false
    override val baseUrl = "https://filesystem.example.test"
}
