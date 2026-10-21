package com.squareup.duktape;
import app.cash.quickjs.QuickJs;
import java.io.Closeable;
/** Legacy extension JS evaluation API, using the same local QuickJS interpreter. */
public final class Duktape implements Closeable {
    private final QuickJs js = QuickJs.create();
    public static Duktape create() { return new Duktape(); }
    public synchronized Object evaluate(String script) { return js.evaluate(script); }
    @Override public void close() { js.close(); }
}
