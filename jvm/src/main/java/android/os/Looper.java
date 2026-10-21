package android.os;

/** Thread identity and FIFO Runnable dispatch for source-side callbacks.
 * This does not create a browser UI or implement Android Message/Handler.
 */
public final class Looper {
    private static final ThreadLocal<Looper> CURRENT = new ThreadLocal<>();
    private static Looper main;
    private final Thread thread;
    private final java.util.ArrayDeque<Runnable> callbacks = new java.util.ArrayDeque<>();
    private boolean quitting;
    private Looper() { thread = Thread.currentThread(); }
    public static void prepare() {
        if (CURRENT.get() != null) throw new IllegalStateException("Only one Looper per thread");
        CURRENT.set(new Looper());
    }
    public static synchronized void prepareMainLooper() {
        if (main != null) throw new IllegalStateException("Main Looper already prepared");
        prepare(); main = CURRENT.get();
    }
    public static Looper myLooper() { return CURRENT.get(); }
    public static synchronized Looper getMainLooper() { return main; }
    public Thread getThread() { return thread; }
    public boolean isCurrentThread() { return thread == Thread.currentThread(); }
    public void enqueueCallback(Runnable callback) {
        java.util.Objects.requireNonNull(callback);
        synchronized (callbacks) {
            if (quitting) throw new IllegalStateException("Looper is quitting");
            callbacks.addLast(callback); callbacks.notifyAll();
        }
    }
    public void quit() { shutdown(false); }
    public void quitSafely() { shutdown(true); }
    private void shutdown(boolean drain) {
        if (this == getMainLooper()) throw new IllegalStateException("Main looper cannot quit");
        synchronized (callbacks) {
            quitting = true;
            if (!drain) callbacks.clear();
            callbacks.notifyAll();
        }
    }
    public static void loop() {
        Looper looper = myLooper();
        if (looper == null) throw new IllegalStateException("Looper.prepare() was not called");
        while (true) {
            Runnable callback;
            synchronized (looper.callbacks) {
                while (looper.callbacks.isEmpty() && !looper.quitting) {
                    try { looper.callbacks.wait(); }
                    catch (InterruptedException ignored) { /* Android loops do not end on interrupt. */ }
                }
                if (looper.callbacks.isEmpty() && looper.quitting) return;
                callback = looper.callbacks.removeFirst();
            }
            callback.run();
        }
    }
}
