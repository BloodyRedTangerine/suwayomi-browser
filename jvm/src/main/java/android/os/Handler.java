package android.os;

/**
 * Browser callback scheduler. The browser page owns the actual document event
 * loop; JVM callbacks are dispatched on short-lived local threads so a
 * blocking source call cannot deadlock a synthetic Android main looper.
 */
public class Handler {
    private final Looper looper;
    public Handler() { this(Looper.myLooper()); }
    public Handler(Looper looper) { this.looper = looper; }
    /** Android API 28+ factory used by kotlinx-coroutines-android. */
    public static Handler createAsync(Looper looper) { return new Handler(looper); }
    public Looper getLooper() { return looper; }
    public boolean post(Runnable runnable) { schedule(runnable, 0); return true; }
    public boolean postDelayed(Runnable runnable, long delayMillis) { schedule(runnable, Math.max(0, delayMillis)); return true; }
    public void removeCallbacks(Runnable runnable) {}
    private static void schedule(Runnable runnable, long delayMillis) {
        Thread thread = new Thread(() -> {
            try { if (delayMillis > 0) Thread.sleep(delayMillis); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
            runnable.run();
        }, "browser-handler");
        thread.setDaemon(true); thread.start();
    }
}
