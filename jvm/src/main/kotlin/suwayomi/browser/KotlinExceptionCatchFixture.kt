package suwayomi.browser

import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Child-loader regression for Kotlin's inline Throwable catch and fallback. */
object KotlinExceptionCatchFixture {
    @JvmStatic fun inlineCatch(): Long {
        val formatter = DateTimeFormatter.ofPattern("dd MMMM, yyyy", Locale.forLanguageTag("es"))
        val zone: ZoneId? = null
        return runCatching {
            LocalDate.parse("01 invalidmonth, 2026", formatter)
                .atStartOfDay(zone ?: formatter.zone ?: ZoneId.systemDefault()).toInstant().toEpochMilli()
        }.getOrDefault(0L)
    }
}
