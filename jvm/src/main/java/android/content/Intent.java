package android.content;

import android.net.Uri;
import android.os.Bundle;

/** Local intent value object; it records arguments but does not launch desktop/native UI. */
public class Intent {
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final String ACTION_SEND = "android.intent.action.SEND";
    public static final String ACTION_MAIN = "android.intent.action.MAIN";
    public static final String CATEGORY_DEFAULT = "android.intent.category.DEFAULT";
    public static final String EXTRA_TEXT = "android.intent.extra.TEXT";
    private String action;
    private Uri data;
    private String type;
    private Class<?> targetClass;
    private final Bundle extras;

    public Intent() { extras = new Bundle(); }
    public Intent(String action) { this(); this.action = action; }
    public Intent(String action, Uri data) { this(action); this.data = data; }
    public Intent(Context context, Class<?> targetClass) { this(); this.targetClass = targetClass; }
    public Intent(Intent other) {
        this.action = other == null ? null : other.action;
        this.data = other == null ? null : other.data;
        this.type = other == null ? null : other.type;
        this.targetClass = other == null ? null : other.targetClass;
        this.extras = other == null ? new Bundle() : new Bundle(other.extras);
    }
    public String getAction() { return action; }
    public Intent setAction(String action) { this.action = action; return this; }
    public Uri getData() { return data; }
    public String getDataString() { return data == null ? null : data.toString(); }
    public Intent setData(Uri data) { this.data = data; this.type = null; return this; }
    public Intent setDataAndType(Uri data, String type) { this.data = data; this.type = type; return this; }
    public String getType() { return type; }
    public Class<?> getTargetClass() { return targetClass; }
    public Intent putExtra(String name, String value) { extras.putString(name, value); return this; }
    public Intent putExtra(String name, int value) { extras.putInt(name, value); return this; }
    public Intent putExtra(String name, long value) { extras.putLong(name, value); return this; }
    public Intent putExtra(String name, boolean value) { extras.putBoolean(name, value); return this; }
    public Intent putExtra(String name, Bundle value) { extras.put(name, value == null ? null : new Bundle(value)); return this; }
    public String getStringExtra(String name) { return extras.getString(name); }
    public int getIntExtra(String name, int fallback) { return extras.getInt(name, fallback); }
    public long getLongExtra(String name, long fallback) { return extras.getLong(name, fallback); }
    public boolean getBooleanExtra(String name, boolean fallback) { return extras.getBoolean(name, fallback); }
    public boolean hasExtra(String name) { return extras.containsKey(name); }
    public Bundle getExtras() { return new Bundle(extras); }
}
