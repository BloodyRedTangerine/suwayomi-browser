package android.content;

import java.io.File;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import xyz.nulldev.androidcompat.io.sharedprefs.JsonSharedPreferences;

/** Android extension context whose files exist only in the browser JVM filesystem. */
public class Context {
    public static final int MODE_PRIVATE = 0;
    public static final int MODE_APPEND = 32768;
    private static final Map<String, JsonSharedPreferences> preferences = new HashMap<>();
    private static Intent lastStartedIntent;
    public SharedPreferences getSharedPreferences(String name, int mode) {
        synchronized (preferences) { return preferences.computeIfAbsent(name, ignored -> new JsonSharedPreferences(null)); }
    }
    public static String exportPreferences() {
        synchronized (preferences) {
            var snapshot = new org.json.JSONObject();
            preferences.forEach((name, values) -> snapshot.put(name, values.saveToJSONObject()));
            return snapshot.toString();
        }
    }
    /** Restore before any source is loaded, preserving Android scalar types. */
    public static void restorePreferences(String snapshot) {
        if (snapshot.length() > 16 * 1024 * 1024) throw new IllegalArgumentException("Preference snapshot exceeds 16 MiB");
        var json = new org.json.JSONObject(snapshot);
        var restored = new HashMap<String, JsonSharedPreferences>();
        for (String name : json.keySet()) {
            var values = new JsonSharedPreferences(null);
            values.loadFromString(json.getJSONObject(name).toString());
            restored.put(name, values);
        }
        synchronized (preferences) { preferences.clear(); preferences.putAll(restored); }
    }
    public Context getApplicationContext() { return this; }
    public File getCacheDir() { return new File("/cache"); }
    public File getFilesDir() { return new File("/data"); }
    private static void fileName(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..") || name.indexOf('/') >= 0 || name.indexOf('\0') >= 0)
            throw new IllegalArgumentException("File name must not contain path separators");
    }
    public File getFileStreamPath(String name) { fileName(name); return new File(getFilesDir(), name); }
    public java.io.FileInputStream openFileInput(String name) throws java.io.FileNotFoundException { return new java.io.FileInputStream(getFileStreamPath(name)); }
    public java.io.FileOutputStream openFileOutput(String name, int mode) throws java.io.FileNotFoundException {
        if (mode != MODE_PRIVATE && mode != MODE_APPEND) throw new IllegalArgumentException("Unsupported file output mode");
        getFilesDir().mkdirs();
        return new java.io.FileOutputStream(getFileStreamPath(name), mode == MODE_APPEND);
    }
    public boolean deleteFile(String name) { return getFileStreamPath(name).delete(); }
    public String[] fileList() { String[] result = getFilesDir().list(); return result == null ? new String[0] : result; }
    public File getDir(String name, int mode) {
        fileName(name);
        if (mode != MODE_PRIVATE) throw new IllegalArgumentException("Unsupported directory mode");
        File dir = new File(getFilesDir(), "app_" + name); dir.mkdirs(); return dir;
    }
    public String getPackageName() { return "suwayomi.browser"; }
    public String getString(int id) { return Integer.toString(id); }
    /** Records a local launch request for the browser UI to handle; never opens a native activity. */
    public void startActivity(Intent intent) {
        synchronized (Context.class) { lastStartedIntent = new Intent(Objects.requireNonNull(intent)); }
    }
    public static Intent getLastStartedIntent() {
        synchronized (Context.class) { return lastStartedIntent == null ? null : new Intent(lastStartedIntent); }
    }
    public static void clearLastStartedIntent() { synchronized (Context.class) { lastStartedIntent = null; } }
}
