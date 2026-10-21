package suwayomi.browser;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.Month;
import java.time.format.DateTimeFormatter;
import java.time.temporal.TemporalAccessor;
import java.util.Date;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/** Exercises localized JRE month formatting and parsing inside the browser WASM JVM. */
public final class LocaleDataProbe {
    private static final String[] LANGUAGES = {"es", "pt", "fr", "it", "ru", "ja", "zh", "id", "vi", "tr"};
    private static final String[] DATE_TIME_MONTHS = {
        "junio", "junho", "juin", "giugno", "июня", "6月", "六月", "Juni", "tháng 6", "Haziran",
    };
    private static final String[] SIMPLE_DATE_MONTHS = {
        "junio", "junho", "juin", "giugno", "июнь", "6月", "六月", "Juni", "Tháng 6", "Haziran",
    };

    private LocaleDataProbe() {}

    public static String verify() {
        var sampleDate = LocalDate.of(2024, Month.JUNE, 15);
        var sampleInstant = Date.from(sampleDate.atStartOfDay(java.time.ZoneOffset.UTC).toInstant());
        var passed = new StringBuilder();
        for (int index = 0; index < LANGUAGES.length; index++) {
            String language = LANGUAGES[index];
            Locale locale = Locale.forLanguageTag(language);
            String monthName = DateTimeFormatter.ofPattern("MMMM", locale).format(sampleDate);
            TemporalAccessor parsedMonth = DateTimeFormatter.ofPattern("MMMM", locale).parse(monthName);
            if (!DATE_TIME_MONTHS[index].equals(monthName) || Month.from(parsedMonth) != Month.JUNE)
                throw new AssertionError("DateTimeFormatter expected localized month for " + language + ", got: " + monthName);

            SimpleDateFormat legacyFormat = new SimpleDateFormat("MMMM", locale);
            String legacyMonthName = legacyFormat.format(sampleInstant);
            ParsePosition position = new ParsePosition(0);
            Date parsedDate = legacyFormat.parse(legacyMonthName, position);
            Calendar parsedCalendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"), locale);
            if (parsedDate != null) parsedCalendar.setTime(parsedDate);
            if (parsedDate == null || position.getIndex() != legacyMonthName.length()
                    || !SIMPLE_DATE_MONTHS[index].equals(legacyMonthName)
                    || parsedCalendar.get(Calendar.MONTH) != Calendar.JUNE)
                throw new AssertionError("SimpleDateFormat expected localized month for " + language + ", got: " + legacyMonthName);

            if (passed.length() > 0) passed.append(", ");
            passed.append(language).append('=').append(monthName).append('/').append(legacyMonthName);
        }
        return "Localized DateTimeFormatter and SimpleDateFormat month parsing passed: " + passed;
    }

}
