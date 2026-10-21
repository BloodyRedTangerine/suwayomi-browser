package suwayomi.browser;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;

/** Synthetic only: no source archive, network, or captured parse input. */
public final class ExceptionCatchFixture {
    public static long throwable() {
        try { return LocalDate.parse("not-a-date", DateTimeFormatter.ISO_DATE).toEpochDay(); }
        catch (Throwable error) { return 0; }
    }
    public static long exception() {
        try { return LocalDate.parse("not-a-date", DateTimeFormatter.ISO_DATE).toEpochDay(); }
        catch (Exception error) { return 0; }
    }
    public static long runtime() {
        try { return LocalDate.parse("not-a-date", DateTimeFormatter.ISO_DATE).toEpochDay(); }
        catch (RuntimeException error) { return 0; }
    }
    public static long exact() {
        try { return LocalDate.parse("not-a-date", DateTimeFormatter.ISO_DATE).toEpochDay(); }
        catch (DateTimeParseException error) { return 0; }
    }
    public static long nativeThrow() {
        try { System.arraycopy(new int[1], 0, new int[1], 0, 2); return 1; }
        catch (Exception error) { return 0; }
    }
    public static long nested() {
        try {
            try { return LocalDate.parse("not-a-date", DateTimeFormatter.ISO_DATE).toEpochDay(); }
            catch (IllegalArgumentException unrelated) { return 2; }
        } catch (Exception expected) { return 0; }
    }
}
