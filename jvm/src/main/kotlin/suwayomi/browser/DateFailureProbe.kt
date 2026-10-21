package suwayomi.browser

import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Synthetic reduction of the source's runCatching date helper; no HTTP or source data. */
object DateFailureProbe {
    @JvmStatic fun run(value: String): String {
        val formatter = DateTimeFormatter.ofPattern("dd MMMM, yyyy", Locale.forLanguageTag("es")).withZone(ZoneId.of("UTC"))
        val epoch = runCatching {
            LocalDate.parse(value, formatter).atStartOfDay(formatter.zone).toInstant().toEpochMilli()
        }.getOrDefault(0L)
        return "epoch=$epoch;continued=true"
    }
}
