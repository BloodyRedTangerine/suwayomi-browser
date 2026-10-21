package android.os;

/** Monotonic browser-JVM clock for extension throttling and token lifetimes.
 * Browser suspension semantics follow the host monotonic clock, not Android
 * device deep-sleep accounting. Wall-clock adjustments cannot move it back. */
public final class SystemClock {
    private SystemClock() {}
    public static long elapsedRealtimeNanos() { return System.nanoTime(); }
    public static long elapsedRealtime() { return elapsedRealtimeNanos() / 1_000_000L; }
    public static long uptimeMillis() { return elapsedRealtime(); }
    public static void sleep(long millis) {
        if (millis <= 0) return;
        long start = uptimeMillis();
        long remaining = millis;
        boolean interrupted = false;
        do {
            try { Thread.sleep(remaining); }
            catch (InterruptedException ignored) { interrupted = true; }
            remaining = millis - (uptimeMillis() - start);
        } while (remaining > 0);
        if (interrupted) Thread.currentThread().interrupt();
    }
}
