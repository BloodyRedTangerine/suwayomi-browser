package android.os;

import java.util.HashMap;
import java.util.Map;

/** Small in-memory Bundle for extension lifecycle and intent arguments. */
public class Bundle {
    private final Map<String, Object> values = new HashMap<>();
    public Bundle() {}
    public Bundle(Bundle other) { if (other != null) values.putAll(other.values); }
    public void putString(String key, String value) { values.put(key, value); }
    public String getString(String key) { Object value = values.get(key); return value instanceof String text ? text : null; }
    public String getString(String key, String fallback) { String value = getString(key); return value == null ? fallback : value; }
    public void putInt(String key, int value) { values.put(key, value); }
    public int getInt(String key) { return getInt(key, 0); }
    public int getInt(String key, int fallback) { Object value = values.get(key); return value instanceof Number number ? number.intValue() : fallback; }
    public void putLong(String key, long value) { values.put(key, value); }
    public long getLong(String key) { return getLong(key, 0L); }
    public long getLong(String key, long fallback) { Object value = values.get(key); return value instanceof Number number ? number.longValue() : fallback; }
    public void putBoolean(String key, boolean value) { values.put(key, value); }
    public boolean getBoolean(String key) { return getBoolean(key, false); }
    public boolean getBoolean(String key, boolean fallback) { Object value = values.get(key); return value instanceof Boolean flag ? flag : fallback; }
    public boolean containsKey(String key) { return values.containsKey(key); }
    public Object get(String key) { return values.get(key); }
    public void put(String key, Object value) { values.put(key, value); }
    public void remove(String key) { values.remove(key); }
    public int size() { return values.size(); }
}
