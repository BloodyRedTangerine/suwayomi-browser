package app.cash.quickjs;
import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import org.json.*;
import suwayomi.browser.BrowserTransport;

/** QuickJS API backed by a locally bundled QuickJS WebAssembly interpreter. */
public final class QuickJs implements Closeable {
    private final int context = BrowserTransport.newScriptContext();
    private boolean closed;
    public static QuickJs create() { return new QuickJs(); }
    public Object evaluate(String script) {
        if (closed) throw new IllegalStateException("QuickJS is closed");
        JSONObject response = new JSONObject(BrowserTransport.script(context, script, "evaluate"));
        if (response.has("error")) throw new QuickJsException(response.getString("error"), null);
        if ("bigint".equals(response.optString("type"))) return new java.math.BigInteger(response.getString("value"));
        Object value = response.opt("value");
        if (value == JSONObject.NULL) return null;
        if (value instanceof JSONArray array) {
            Object[] items = new Object[array.length()];
            boolean numbers = true, integers = true, strings = true, booleans = true;
            for (int i = 0; i < items.length; i++) {
                items[i] = array.get(i);
                numbers &= items[i] instanceof Number;
                integers &= items[i] instanceof Integer;
                strings &= items[i] instanceof String;
                booleans &= items[i] instanceof Boolean;
            }
            if (integers) { int[] result = new int[items.length]; for (int i = 0; i < items.length; i++) result[i] = ((Number)items[i]).intValue(); return result; }
            if (numbers) { double[] result = new double[items.length]; for (int i = 0; i < items.length; i++) result[i] = ((Number)items[i]).doubleValue(); return result; }
            if (strings) { String[] result = new String[items.length]; System.arraycopy(items, 0, result, 0, items.length); return result; }
            if (booleans) { boolean[] result = new boolean[items.length]; for (int i = 0; i < items.length; i++) result[i] = (Boolean)items[i]; return result; }
            return items;
        }
        return value;
    }
    public Object evaluate(String script, String fileName) { return evaluate(script); }
    public byte[] compile(String source, String fileName) { return source.getBytes(StandardCharsets.UTF_8); }
    public Object execute(byte[] program) { return evaluate(new String(program, StandardCharsets.UTF_8)); }
    @Override public void close() {
        if (!closed) { BrowserTransport.script(context, "", "close"); closed = true; }
    }
}
